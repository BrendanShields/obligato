import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openDb, promoteInferred, registerArtifact } from "@kelson/kernel";
import { DriftListResult } from "@kelson/schemas";
import { PROMOTE_ENTRY } from "../../src/commands/drift.ts";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const REPO_KEY = "r";

const seedDrift = (db: Database, n: number): void => {
  // two modules; every third item anchors on an inferred artifact
  for (let i = 0; i < n; i++) {
    const module = i % 2 === 0 ? "m1" : "m2";
    const inferred = i % 3 === 0;
    const artifactId = `${module}/${inferred ? `inf-${i}.spec.md#C-${i}` : `code-${i}.ts`}`;
    registerArtifact(db, {
      repo: REPO_KEY,
      logical_id: artifactId,
      type: inferred ? "spec" : "code_region",
      content: `v${i}`,
      authority: inferred ? "inferred" : "authored",
    });
    db.query(
      `INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, resolution, schema_version)
       VALUES (?, ?, ?, 'spec_over_code', ?, 'open', 1)`,
    ).run(`drift-${i}`, REPO_KEY, artifactId, "2026-07-01T00:00:00Z");
  }
};

const authorities = (db: Database): Record<string, string> =>
  Object.fromEntries(
    (
      db
        .query("SELECT logical_id, authority FROM artifact WHERE repo = ?")
        .all(REPO_KEY) as { logical_id: string; authority: string }[]
    ).map((r) => [r.logical_id, r.authority]),
  );

describe("UX-22: drift list survival table + fatigue collapse; promote is all-or-nothing via promoteInferred", () => {
  it("the CLI promote dispatch target is the exported kernel promoteInferred (F-085 identity)", () => {
    expect(PROMOTE_ENTRY).toBe(promoteInferred);
  });

  it("11 open items collapse to authority-split module counts; 10 render itemized; survival renders fully in both", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    const db = openDb(dbPath);
    seedDrift(db, 11);
    db.close();
    const collapsed = await runCli(t, [
      "drift",
      "list",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
      "--json",
    ]);
    expect(collapsed.exitCode).toBe(0);
    const c = DriftListResult.parse(JSON.parse(collapsed.stdout));
    expect(c.collapsed).toBe(true);
    expect(c.items).toHaveLength(0);
    // counts stay split by authority (divergence pin F-150)
    const m1 = c.modules.find((m) => m.module === "m1");
    expect(m1).toBeDefined();
    expect((m1?.blocking ?? 0) + (m1?.informational ?? 0)).toBeGreaterThan(0);
    expect(c.modules.some((m) => m.informational > 0)).toBe(true);
    // survival table exempt from the fatigue budget
    expect(c.survival.length).toBeGreaterThan(0);

    // resolve one event → exactly 10 open → itemized
    const db2 = openDb(dbPath);
    db2
      .query(
        "UPDATE drift_event SET resolution = 'repaired' WHERE id = 'drift-0'",
      )
      .run();
    db2.close();
    const itemized = await runCli(t, [
      "drift",
      "list",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
      "--json",
    ]);
    const i = DriftListResult.parse(JSON.parse(itemized.stdout));
    expect(i.collapsed).toBe(false);
    expect(i.items).toHaveLength(10);
    expect(i.survival.length).toBeGreaterThan(0);
  }, 30_000);

  it("promote flips exactly the named artifacts to confirmed; a selection with one non-inferred id flips nothing; empty flips nothing", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    const db = openDb(dbPath);
    seedDrift(db, 4); // inf-0, inf-3 inferred; code-1, code-2 authored
    const before = authorities(db);
    db.close();

    // invalid batch: one inferred + one authored → rejected as a whole
    const bad = await runCli(t, [
      "drift",
      "promote",
      "m1/inf-0.spec.md#C-0",
      "m2/code-1.ts",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("m2/code-1.ts");
    const dbA = openDb(dbPath);
    expect(authorities(dbA)).toEqual(before); // read back: nothing flipped
    dbA.close();

    // empty selection: exit 0, nothing flipped
    const empty = await runCli(t, [
      "drift",
      "promote",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
    ]);
    expect(empty.exitCode).toBe(0);
    const dbB = openDb(dbPath);
    expect(authorities(dbB)).toEqual(before);
    dbB.close();

    // valid selection flips exactly the named ids
    const good = await runCli(t, [
      "drift",
      "promote",
      "m1/inf-0.spec.md#C-0",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
    ]);
    expect(good.exitCode).toBe(0);
    const dbC = openDb(dbPath);
    const after = authorities(dbC);
    dbC.close();
    expect(after["m1/inf-0.spec.md#C-0"]).toBe("confirmed");
    expect(after["m2/inf-3.spec.md#C-3"]).toBe("inferred"); // untouched sibling

    // a duplicated id promotes once (deduped return)
    const dup = await runCli(t, [
      "drift",
      "promote",
      "m2/inf-3.spec.md#C-3",
      "m2/inf-3.spec.md#C-3",
      "--repo",
      REPO_KEY,
      "--db",
      dbPath,
    ]);
    expect(dup.exitCode).toBe(0);
    expect(dup.stdout).toContain("promoted 1 clause(s)");
    const dbD = openDb(dbPath);
    expect(authorities(dbD)["m2/inf-3.spec.md#C-3"]).toBe("confirmed");
    dbD.close();
  }, 30_000);
});
