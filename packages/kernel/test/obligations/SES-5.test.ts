import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSession } from "../../../cc-plugin/src/session.ts";
import {
  KERNEL_MIGRATIONS_DIR,
  openDb,
  startSession,
} from "../../src/index.ts";
import { makeRepo } from "../eval-helpers.ts";

const SESSION_ARGS = {
  repo: "r",
  lockfile_hash: `sha256:${"0".repeat(64)}`,
  harness_version: "0.0.1",
};

describe("SES-5: session.runner is additive and stamped by every creator", () => {
  it("a pre-0008 row reads back null after the migration (additive, no rewrite)", () => {
    // Build a db at migration 0007, insert a legacy-shaped row, then apply
    // the full migration set — the discriminating pre-column fixture.
    const partialDir = mkdtempSync(join(tmpdir(), "kelson-mig-"));
    for (const f of readdirSync(KERNEL_MIGRATIONS_DIR).filter(
      (f) => f <= "0007",
    ))
      cpSync(join(KERNEL_MIGRATIONS_DIR, f), join(partialDir, f));
    const dbPath = join(mkdtempSync(join(tmpdir(), "kelson-db-")), "k.db");
    const oldDb = openDb(dbPath, partialDir);
    oldDb
      .query(
        `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, trace_id, started_at, ended_at)
         VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'r', ?, '0.0.1', 1, 'complete', NULL, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run(SESSION_ARGS.lockfile_hash);
    oldDb.close();

    const db = openDb(dbPath);
    const row = db
      .query(
        "SELECT runner FROM session WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'",
      )
      .get() as { runner: string | null };
    expect(row.runner).toBeNull();
    db.close();
  });

  it("startSession persists the stated runner for every value", () => {
    const db = openDb(":memory:");
    for (const runner of ["cc", "native", null] as const) {
      const id = startSession(db, { ...SESSION_ARGS, runner });
      const row = db
        .query("SELECT runner FROM session WHERE id = ?")
        .get(id) as { runner: string | null };
      expect(row.runner).toBe(runner);
    }
  });

  it("the cc-plugin session creator stamps runner = 'cc'", () => {
    const db = openDb(":memory:");
    const repo = makeRepo({ "README.md": "x\n" });
    const id = beginSession(db, repo);
    const row = db.query("SELECT runner FROM session WHERE id = ?").get(id) as {
      runner: string | null;
    };
    expect(row.runner).toBe("cc");
  });
});
