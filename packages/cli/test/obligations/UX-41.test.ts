import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, ulid } from "@obligato/kernel";
import { MetricsReport } from "@obligato/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

// Hand-seeded: 2 accepted (one 1234-µUSD step each, 150 tokens each) + 1
// corrected, all delivered; 1 drift event. Expected values derived by hand:
// FPAR 2/3, TPAC 1234, tokens 150, correction 1/3, no verdicts → null.
const seedStore = (dbPath: string): void => {
  const db = openDb(dbPath);
  const at = "2026-09-01T02:00:00.000Z";
  const sessionId = ulid();
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, runner, trace_id, started_at, ended_at)
     VALUES (?, 'r', ?, '0.1.0', 1, 'complete', 'native', NULL, ?, ?)`,
  ).run(sessionId, `sha256:${"a".repeat(64)}`, at, at);
  const accepted = [ulid(), ulid()];
  for (const id of accepted)
    db.query(
      `INSERT INTO task (id, repo, spec_clause_refs, state, acceptance_signal, correction_count, opened_at, delivered_at, closed_at)
       VALUES (?, 'r', '[]', 'accepted', 'approval', 0, ?, ?, ?)`,
    ).run(id, at, at, at);
  db.query(
    `INSERT INTO task (id, repo, spec_clause_refs, state, acceptance_signal, correction_count, opened_at, delivered_at, closed_at)
     VALUES (?, 'r', '[]', 'corrected', NULL, 1, ?, ?, ?)`,
  ).run(ulid(), at, at, at);
  for (const taskId of accepted)
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
       VALUES (?, ?, ?, 'build', 'mock-m', 'medium', 'native', 100, 50, 0, 0, '{}', 1234, 20000, 'none', NULL, 1)`,
    ).run(ulid(), taskId, sessionId);
  db.query(
    "INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, schema_version) VALUES (?, 'r', 'a', 'code_under_spec', ?, 1)",
  ).run(ulid(), at);
  db.close();
};

const paths: string[] = [];
const collector = Bun.serve({
  port: 0,
  fetch: async (req) => {
    paths.push(new URL(req.url).pathname);
    await req.text();
    return new Response("{}", { status: 200 });
  },
});
afterAll(() => collector.stop(true));

describe("UX-41: obligato metrics renders TEL-8 through the component layer; --json validates; null rates are n/a; --otel is the only network path; a missing store is refused", () => {
  it("--json parses as MetricsReport with the hand-computed values, and the rendered panel carries the same numbers", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    seedStore(dbPath);
    const j = await runCli(t, ["metrics", "--db", dbPath, "--json"]);
    expect(j.exitCode).toBe(0);
    const report = MetricsReport.parse(JSON.parse(j.stdout));
    expect(report.fpar).toBe(2 / 3);
    expect(report.tpac_micro_usd).toBe(1234);
    expect(report.tokens_per_accepted).toBe(150);
    expect(report.correction_rate).toBe(1 / 3);
    expect(report.spec_drift_incidents).toBe(1);
    expect(report.gate.pass_rate).toBeNull();

    const r = await runCli(t, ["metrics", "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    // revert-check: format FPAR with toFixed(0) → "67%" and the 66.7% line fails.
    expect(r.stdout).toContain("66.7% (2 of 3 closed)");
    expect(r.stdout).toContain("$0.0012 / accepted change");
    expect(r.stdout).toContain("150 tok / accepted change");
    expect(r.stdout).toContain("33.3% of 3 delivered");
    expect(r.stdout).toContain("1 incidents");
    expect(r.stdout).toContain("n/a (0 verdicts)");
    expect(r.stdout).toContain("mock-m");
    expect(r.stdout).toContain("300 tok");
    expect(r.stdout).toContain("1 total · 1 complete");
    expect(r.stdout).toContain("cc 0 · native 1 · unknown 0");
    // UX-4: every line fits 80 columns.
    for (const line of r.stdout.split("\n"))
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });

  it("an empty store renders n/a (0 tasks) for FPAR and never a 0% rate", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    openDb(dbPath).close();
    const r = await runCli(t, ["metrics", "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    // revert-check: render a null rate through pct(0) → "0.0%" appears and
    // the not.toContain below fails.
    expect(r.stdout).toContain("n/a (0 tasks)");
    expect(r.stdout).not.toContain("0%");
    expect(r.stdout).toContain("n/a (0 product spend)");
  });

  it("--otel posts exactly one /v1/metrics request; without the flag no request is made", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    seedStore(dbPath);
    const before = paths.length;
    const plain = await runCli(t, ["metrics", "--db", dbPath]);
    expect(plain.exitCode).toBe(0);
    expect(paths.length).toBe(before);
    const r = await runCli(t, [
      "metrics",
      "--db",
      dbPath,
      "--otel",
      `http://127.0.0.1:${collector.port}`,
    ]);
    expect(r.exitCode).toBe(0);
    expect(paths.slice(before)).toEqual(["/v1/metrics"]);
    expect(r.stdout).toContain("exported 14 gauges");
  });

  it("a missing store exits non-zero naming obligato init and is not created", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "absent.db");
    const r = await runCli(t, ["metrics", "--db", dbPath]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("obligato init");
    // revert-check: drop the existsSync guard → openDb creates the file and
    // this assertion fails.
    expect(existsSync(dbPath)).toBe(false);
  });
});
