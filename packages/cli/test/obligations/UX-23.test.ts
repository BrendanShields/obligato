import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, validateReplay } from "@obligato/kernel";
import { EvalReportResult, ReplayResult } from "@obligato/schemas";
import {
  baseTask,
  lockWith,
  makeSnapshot,
  makeSuite,
  tmpDir,
} from "../../../kernel/test/eval-helpers.ts";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const SID = "01HZZZZZZZZZZZZZZZZZZZZZC1";

describe("UX-23: eval report re-renders stored verdicts without executing; replay links source session and run", () => {
  it("report renders both stored verdicts with CI bounds and inserts no eval_run row", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const db = openDb(dbPath);
    const insertRun = db.query(
      `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
         VALUES (?, 'ablate', 's', '1', ?, ?, 0, 'command', '{}', '{}', ?, ?, ?)`,
    );
    const insertVerdict = db.query(
      `INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, ?, ?, ?, 0.05)`,
    );
    const hash = `sha256:${"e".repeat(64)}`;
    for (const [i, decision] of (
      ["helps", "underpowered"] as const
    ).entries()) {
      const runId = `01HZZZZZZZZZZZZZZZZZZZZZA${i}`;
      insertRun.run(
        runId,
        hash,
        hash,
        hash,
        "2026-07-05T00:00:00Z",
        "2026-07-05T00:01:00Z",
      );
      insertVerdict.run(
        `01HZZZZZZZZZZZZZZZZZZZZZB${i}`,
        runId,
        decision,
        JSON.stringify({
          fpar: { mean: 0.25, ci95: [0.1, 0.4] },
          cost_pct: { mean: -2, ci95: [-5, 1] },
        }),
        4,
      );
    }
    const runCount = () =>
      (db.query("SELECT COUNT(*) AS n FROM eval_run").get() as { n: number }).n;
    const before = runCount();
    db.close();

    const rendered = await runCli(t, ["eval", "report", "--db", dbPath]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain("helps");
    expect(rendered.stdout).toContain("underpowered");
    expect(rendered.stdout).toContain("[0.100, 0.400]"); // CI bounds, never a bare label

    const j = await runCli(t, ["eval", "report", "--db", dbPath, "--json"]);
    const parsed = EvalReportResult.parse(JSON.parse(j.stdout));
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs.every((r) => r.fpar_delta.ci95.length === 2)).toBe(true);

    const db2 = openDb(dbPath);
    expect(
      (db2.query("SELECT COUNT(*) AS n FROM eval_run").get() as { n: number })
        .n,
    ).toBe(before); // nothing executed
    db2.close();
  }, 30_000);

  it("replay of a promoted session re-runs the task, records the linking replay_record with validity from validateReplay", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const store = tmpDir();
    const snapshot = makeSnapshot({ "README.md": "fixture\n" }, store);
    const suiteDir = makeSuite([
      baseTask({ id: `session-${SID.toLowerCase()}`, snapshot }),
    ]);
    const lockPath = join(t.repo, "candidate.lock");
    writeFileSync(lockPath, JSON.stringify(lockWith([])));

    const db = openDb(dbPath);
    db.query(
      `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, started_at)
         VALUES (?, 'r', ?, 'test', 1, 'complete', '2026-07-05T00:00:00Z')`,
    ).run(SID, `sha256:${"f".repeat(64)}`);
    db.close();

    const r = await runCli(t, [
      "eval",
      "replay",
      "--session",
      SID,
      "--suite",
      suiteDir,
      "--config",
      lockPath,
      "--executor",
      "command",
      "--snapshots",
      store,
      "--db",
      dbPath,
      "--json",
    ]);
    expect(`${r.exitCode} ${r.stderr}`).toStartWith("0");
    const { record } = ReplayResult.parse(JSON.parse(r.stdout));
    expect(record.source_session_id).toBe(SID);
    expect(record.run_id).not.toBeNull();
    // validity computed by the exported validateReplay (identity of
    // semantics: same inputs, same answer)
    const expected = validateReplay({
      snapshotHash: snapshot,
      storeDir: store,
      originalStatus: "complete",
      originalModels: [],
      candidateModels: [],
    });
    expect(record.validity).toBe(expected.validity);
    expect(record.advisory_reason).toBe(expected.reason);
    expect(record.outcome.original_fpar_pass).toBe(true);

    const db2 = openDb(dbPath);
    const run = db2
      .query("SELECT kind FROM eval_run WHERE id = ?")
      .get(record.run_id) as { kind: string } | null;
    // EVP-5 fence: a replay writes no eval_task_result rows
    const taskResults = (
      db2
        .query("SELECT COUNT(*) AS n FROM eval_task_result WHERE run_id = ?")
        .get(record.run_id) as { n: number }
    ).n;
    db2.close();
    expect(run?.kind).toBe("replay");
    expect(taskResults).toBe(0);
  }, 120_000);

  it("a replay against a missing snapshot exits non-zero with the run's finished_at set (no dangling running row)", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const store = tmpDir(); // empty store: the snapshot bundle is absent
    const sid = "01HZZZZZZZZZZZZZZZZZZZZZE7";
    const suiteDir = makeSuite([
      baseTask({
        id: `session-${sid.toLowerCase()}`,
        snapshot: `sha256:${"9".repeat(64)}`,
      }),
    ]);
    const lockPath = join(t.repo, "candidate.lock");
    writeFileSync(lockPath, JSON.stringify(lockWith([])));
    const db = openDb(dbPath);
    db.query(
      `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, started_at)
       VALUES (?, 'r', ?, 'test', 1, 'complete', '2026-07-05T00:00:00Z')`,
    ).run(sid, `sha256:${"f".repeat(64)}`);
    db.close();
    const r = await runCli(t, [
      "eval",
      "replay",
      "--session",
      sid,
      "--suite",
      suiteDir,
      "--config",
      lockPath,
      "--executor",
      "command",
      "--snapshots",
      store,
      "--db",
      dbPath,
    ]);
    expect(r.exitCode).not.toBe(0);
    const db2 = openDb(dbPath);
    const row = db2
      .query(
        "SELECT finished_at FROM eval_run WHERE kind = 'replay' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { finished_at: string | null } | null;
    db2.close();
    expect(row).not.toBeNull();
    expect(row?.finished_at).not.toBeNull();
  }, 60_000);

  it("a session with no promoted benchmark task errors naming `obligato promote`", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const store = tmpDir();
    const snapshot = makeSnapshot({ "README.md": "x\n" }, store);
    const suiteDir = makeSuite([baseTask({ id: "unrelated", snapshot })]);
    const lockPath = join(t.repo, "candidate.lock");
    writeFileSync(lockPath, JSON.stringify(lockWith([])));
    const r = await runCli(t, [
      "eval",
      "replay",
      "--session",
      "01HZZZZZZZZZZZZZZZZZZZZZD9",
      "--suite",
      suiteDir,
      "--config",
      lockPath,
      "--db",
      dbPath,
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("obligato promote");
  }, 60_000);
});
