import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@obligato/agent";
import {
  openDb,
  recordDivergence,
  registerArtifact,
  searchView,
  startSession,
  ulid,
} from "@obligato/kernel";
import { UiSearchView } from "@obligato/schemas";
import { API_PATHS, createUiServer } from "../../src/ui/server.ts";

const LOCK = `sha256:${"0".repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), "obligato-ux51-"));
const dbPath = join(dir, "k.db");
const db = openDb(dbPath);

// One matching row per searchable kind, all carrying "alpha".
const { sessionId } = createAgentSession(db, {
  repo: "alpha-repo",
  lockfile_hash: LOCK,
  harness_version: "0.0.1",
  model: "mock-m",
  system: "sys",
  auth_kind: "none",
});
const runId = ulid();
// eval_run is only ever written by runEval (executes tasks) — seeded raw.
db.query(
  `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
   VALUES (?, 'ablate', 'alpha-suite', '1', '{}', '{}', 0, 'command', '{}', '{}', ?, ?, ?)`,
).run(runId, LOCK, "2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z");
const proposalId = ulid();
// createProposal resolves evidence links against a repo; the search view only
// needs the row — seeded raw with the migration's columns.
db.query(
  `INSERT INTO proposal (id, target_pack, diff, diff_hash, evidence, rationale, created_by, state, quarantine_reason, created_at, updated_at, schema_version)
   VALUES (?, 'p', '{}', ?, '[]', 'alpha rationale', 'human', 'proposed', NULL, ?, ?, 1)`,
).run(proposalId, LOCK, "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
const divergenceId = recordDivergence(db, "spec alpha", {
  status: "diverged",
  seed: 1,
  entries: [{ clause_id: "ALPHA-1" } as never],
});
registerArtifact(db, {
  repo: "alpha-repo",
  logical_id: "specs/alpha.spec.md#ALPHA-1",
  type: "spec",
  content: "x",
});
const server = createUiServer({ dbPath, port: 0 });
afterAll(() => {
  server.stop(true);
  db.close();
});

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("UX-51: search view — one hit per kind in pinned order, literal matching, capped, GET-only SPA", () => {
  it("returns one hit per kind in the pinned order with the pinned verbs", () => {
    const view = searchView(db, "alpha");
    expect(UiSearchView.safeParse(view).success).toBe(true);
    expect(view.query).toBe("alpha");
    // revert-check: reorder the collect() calls → the kinds array differs.
    expect(view.hits.map((h) => h.kind)).toEqual([
      "session",
      "eval_run",
      "proposal",
      "divergence",
      "clause",
    ]);
    expect(view.hits.map((h) => h.command)).toEqual([
      `obligato session show ${sessionId}`,
      "obligato eval report",
      `obligato loop review ${proposalId}`,
      `obligato divergence show ${divergenceId}`,
      "obligato drift list",
    ]);
    expect(view.hits[0]).toMatchObject({ id: sessionId, label: "alpha-repo" });
    expect(view.hits[4]).toMatchObject({
      id: "specs/alpha.spec.md#ALPHA-1",
      label: "spec T0",
    });
  });

  it("matching is case-insensitive; nothing, empty, and whitespace queries yield []", () => {
    expect(searchView(db, "ALPHA").hits).toHaveLength(5);
    expect(searchView(db, "zzz-nothing").hits).toEqual([]);
    expect(searchView(db, "").hits).toEqual([]);
    expect(searchView(db, "   ").hits).toEqual([]);
    expect(searchView(db, "").empty_verb).toBe("obligato chat");
  });

  it("a %-containing query matches literally — no wildcard expansion", () => {
    // revert-check: drop the ESCAPE clause / escaping → "alph%" expands to
    // LIKE '%alph%%' and matches all five rows.
    expect(searchView(db, "alph%").hits).toEqual([]);
    expect(searchView(db, "_lpha").hits).toEqual([]);
  });

  it("caps at 50 hits", () => {
    for (let i = 0; i < 60; i++)
      startSession(db, {
        runner: "native",
        repo: "bulk-repo",
        lockfile_hash: LOCK,
        harness_version: "0.0.1",
      });
    const view = searchView(db, "bulk-repo");
    // revert-check: remove the SEARCH_CAP guard → 60 hits, schema max(50) fails.
    expect(view.hits).toHaveLength(50);
    expect(UiSearchView.safeParse(view).success).toBe(true);
  });

  it("GET /api/search?q= serves the same function's return and parses; the example path is registered", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/search?q=alpha`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(UiSearchView.safeParse(body).success).toBe(true);
    expect(body).toEqual(JSON.parse(JSON.stringify(searchView(db, "alpha"))));
    expect(API_PATHS).toContain("/api/search?q=");
  });

  it("structural: no SPA source issues a fetch with a method option (GET-only by construction)", () => {
    const uiSrc = join(import.meta.dir, "..", "..", "..", "ui", "src");
    const files = walk(uiSrc).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // revert-check: add `fetch(url, { method: "POST" })` anywhere under
      // packages/ui/src → this loop fails on that file.
      expect(`${f}: ${/method\s*:/.test(src)}`).toBe(`${f}: false`);
    }
  });
});
