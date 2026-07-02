import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DB_PATH, openDb } from "@kelson/kernel";
import { createUiServer, resolveUiDbPath } from "../../src/ui/server.ts";

describe("UX-13: kelson ui resolves its store repo-first; --db overrides", () => {
  it("prefers ./.kelson/kelson.db when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "kelson-ux13-"));
    mkdirSync(join(dir, ".kelson"));
    writeFileSync(join(dir, ".kelson", "kelson.db"), "");
    expect(resolveUiDbPath(dir)).toBe(join(dir, ".kelson", "kelson.db"));
  });

  it("falls back to the user store when the repo has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "kelson-ux13-"));
    expect(resolveUiDbPath(dir)).toBe(DEFAULT_DB_PATH);
  });

  it("wiring: a server created with no dbPath serves the repo store's rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kelson-ux13-wire-"));
    mkdirSync(join(dir, ".kelson"));
    const repoDb = join(dir, ".kelson", "kelson.db");
    const db = openDb(repoDb);
    db.query(
      `INSERT INTO proposal (id, target_pack, diff, diff_hash, evidence, rationale,
        created_by, state, created_at, updated_at, schema_version)
       VALUES ('01JZWX13000000000000000000', 'ux13-probe-pack', '{}',
        'sha256:${"0".repeat(64)}', '[]', 'ux13 wiring probe', 'human',
        'proposed', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z', 1)`,
    ).run();
    db.close();

    const savedCwd = process.cwd();
    process.chdir(dir);
    let server: ReturnType<typeof createUiServer>;
    try {
      server = createUiServer({ port: 0 }); // no dbPath — must resolve repo-first
    } finally {
      process.chdir(savedCwd);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/loop`);
      const body = (await res.json()) as {
        proposals: { target_pack: string }[];
      };
      // discriminating: the user store has no such row — reverting the
      // default to DEFAULT_DB_PATH makes this list empty and fails here
      expect(body.proposals.map((p) => p.target_pack)).toContain(
        "ux13-probe-pack",
      );
    } finally {
      server.stop(true);
    }
  });
});
