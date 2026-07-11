import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openDb } from "@obligato/kernel";
import { DivergenceListResult } from "@obligato/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const seed = (dbPath: string): void => {
  const db = openDb(dbPath);
  const insert = db.query(
    `INSERT INTO divergence_report (id, spec_hash, clause_ids, entries, resolved, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  );
  insert.run(
    "div-resolved",
    `sha256:${"a".repeat(64)}`,
    JSON.stringify(["GRT-1"]),
    JSON.stringify([]),
    1,
    "2026-07-01T00:00:00Z",
  );
  insert.run(
    "div-open",
    `sha256:${"b".repeat(64)}`,
    JSON.stringify(["GRT-2"]),
    JSON.stringify([
      {
        clause_id: "GRT-2",
        probe_input: { name: "ada" },
        differing_path: "greeting",
        outcome_a: { tag: "returned", value: "hi ada" },
        outcome_b: { tag: "threw", errorName: "RangeError" },
        redacted_paths: [],
      },
    ]),
    0,
    "2026-07-02T00:00:00Z",
  );
  db.close();
};

describe("UX-20: divergence show renders probe input and both behaviors side-by-side; list orders unresolved first", () => {
  it("show renders the probe input, both outcomes, and the clause ids", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    seed(dbPath);
    const r = await runCli(t, [
      "divergence",
      "show",
      "div-open",
      "--db",
      dbPath,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('{"name":"ada"}'); // the concrete probe input (§5.2)
    expect(r.stdout).toContain("GRT-2");
    expect(r.stdout).toContain("returned");
    expect(r.stdout).toContain("threw RangeError");
  }, 30_000);

  it("list --json orders unresolved before resolved and parses with the registered schema", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    seed(dbPath);
    const r = await runCli(t, ["divergence", "list", "--db", dbPath, "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = DivergenceListResult.parse(JSON.parse(r.stdout));
    expect(parsed.reports.map((x) => x.resolved)).toEqual([false, true]);
    expect(parsed.reports[0]?.id).toBe("div-open");
  }, 30_000);
});
