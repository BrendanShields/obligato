import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { UiBenchView } from "@kelson/schemas";
import { createUiServer } from "../../src/ui/server.ts";

const RUN_ID = "01HZZZZZZZZZZZZZZZZZZZZZZA";

const seed = (dbPath: string): void => {
  const db = openDb(dbPath);
  db.query(
    `INSERT INTO bench_run (id, suite_id, suite_version, executor_candidate, executor_baseline,
       config, seed, repeats, model_versions, sandbox_profile, manifest_hash, verdict, started_at, finished_at)
     VALUES (?, 's', '1', 'api', 'claude', ?, 0, 2, '{}', '{}', ?, ?, ?, ?)`,
  ).run(
    RUN_ID,
    `sha256:${"c".repeat(64)}`,
    `sha256:${"d".repeat(64)}`,
    JSON.stringify({
      id: "01HZZZZZZZZZZZZZZZZZZZZZZB",
      run_id: RUN_ID,
      decision: "helps",
      fpar_delta: { mean: 0.5, ci95: [0.1, 0.9] },
      cost_delta_pct: { mean: -3, ci95: [-6, 0] },
      n: 1,
      alpha: 0.05,
      bootstrap_resamples: 300,
      quarantined_tasks: [],
    }),
    "2026-07-05T00:00:00Z",
    "2026-07-05T00:01:00Z",
  );
  const insert = db.query(
    `INSERT INTO bench_task_result (id, run_id, bench_task_id, agent, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
     VALUES (?, ?, 't1', ?, ?, ?, ?, '[]', NULL, 1)`,
  );
  // candidate passes both repeats; baseline splits 1/2 → strict majority fails
  insert.run("r1", RUN_ID, "candidate", 0, 1, 100);
  insert.run("r2", RUN_ID, "candidate", 1, 1, 300);
  insert.run("r3", RUN_ID, "baseline", 0, 1, 400);
  insert.run("r4", RUN_ID, "baseline", 1, 0, 600);
  db.close();
};

describe("UX-25: /api/bench renders the per-agent matrix and CI-carrying verdict; empty store names kelson bench", () => {
  const dir = mkdtempSync(join(tmpdir(), "kelson-ux25-"));

  it("an empty store returns 200 with the schema-valid empty state naming `kelson bench`", async () => {
    const dbPath = join(dir, "empty.db");
    openDb(dbPath).close();
    const server = createUiServer({ dbPath, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/bench`);
      expect(res.status).toBe(200);
      const view = UiBenchView.parse(await res.json());
      expect(view.runs).toHaveLength(0);
      expect(view.empty_verb).toContain("kelson bench");
    } finally {
      server.stop(true);
    }
  });

  it("a seeded bench run parses with UiBenchView carrying per-task rows and a verdict with CIs", async () => {
    const dbPath = join(dir, "seeded.db");
    seed(dbPath);
    const server = createUiServer({ dbPath, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/bench`);
      expect(res.status).toBe(200);
      const view = UiBenchView.parse(await res.json());
      expect(view.runs).toHaveLength(1);
      const run = view.runs[0];
      expect(run?.candidate).toBe("api");
      expect(run?.decision).toBe("helps");
      expect(run?.fpar_delta?.ci95).toEqual([0.1, 0.9]);
      // EVP-11 aggregation semantics: strict majority + mean cost
      expect(run?.rows).toEqual([
        {
          task_id: "t1",
          candidate_fpar: 1,
          baseline_fpar: 0,
          candidate_cost_micro_usd: 200,
          baseline_cost_micro_usd: 500,
        },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
