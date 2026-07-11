import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, rebuildIndex, registerArtifact } from "@obligato/kernel";
import { IndexRebuildResult } from "@obligato/schemas";
import { REBUILD_ENTRY } from "../../src/commands/reindex.ts";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

const SPEC = `# fixture spec

\`\`\`obspec
kind: component
id: greeter
tier: T0
authority: authored
events: [name_submitted]
\`\`\`

\`\`\`obspec
kind: domain
id: Name
type: string
max_length: 40
\`\`\`

\`\`\`obspec
kind: clause
id: GRT-1
ears: event
trigger: name_submitted
text: When a name is submitted, the greeter shall include it verbatim in the greeting.
inputs: { name: Name }
observe: [greeting]
check: |
  (ctx) => ctx.expect(ctx.greeting.includes(ctx.name))
\`\`\`
`;

const REPO_KEY = "r";
const SPEC_REL = join("specs", "greeter.spec.md");

const setup = (): { t: TestRepo; dbPath: string } => {
  const t = makeTestRepo({});
  mkdirSync(join(t.repo, "specs"), { recursive: true });
  writeFileSync(join(t.repo, SPEC_REL), SPEC);
  return { t, dbPath: join(t.repo, ".obligato", "obligato.db") };
};

const rebuild = (t: TestRepo, dbPath: string) =>
  runCli(t, [
    "index",
    "rebuild",
    "--repo",
    REPO_KEY,
    "--dir",
    t.repo,
    "--db",
    dbPath,
    "--json",
  ]);

const artifactRows = (db: Database): Map<string, string> =>
  new Map(
    (
      db
        .query(
          "SELECT logical_id, content_hash FROM artifact WHERE repo = ? ORDER BY logical_id",
        )
        .all(REPO_KEY) as { logical_id: string; content_hash: string }[]
    ).map((r) => [r.logical_id, r.content_hash]),
  );

describe("UX-26: index rebuild reconciles the artifact index with pinned count semantics (F-151)", () => {
  it("the CLI dispatch target is the exported kernel rebuildIndex (F-085 identity)", () => {
    expect(REBUILD_ENTRY).toBe(rebuildIndex);
  });

  it("corrupt hash → one changed row restored; deleted spec source → discrepancy deleted; opaque row untouched; second run reports zeros; broken source aborts unchanged", async () => {
    const { t, dbPath } = setup();
    // seed a provably-spec-derived row whose source never existed on disk,
    // and an opaque row outside the covered universe
    const db0 = openDb(dbPath);
    registerArtifact(db0, {
      repo: REPO_KEY,
      logical_id: "specs/gone.spec.md#OLD-1",
      type: "spec",
      content: "orphan",
      authority: "inferred",
    });
    registerArtifact(db0, {
      repo: REPO_KEY,
      logical_id: "opaque-artifact",
      type: "idea",
      content: "not a file",
    });
    db0.close();

    // first rebuild: ingests the spec's rows, deletes the orphan clause
    const first = await rebuild(t, dbPath);
    expect(first.exitCode).toBe(0);
    const r1 = IndexRebuildResult.parse(JSON.parse(first.stdout));
    expect(r1.ingested).toBeGreaterThan(0);
    expect(r1.discrepancies).toBe(1);
    const db1 = openDb(dbPath);
    const rows1 = artifactRows(db1);
    db1.close();
    expect(rows1.has("specs/gone.spec.md#OLD-1")).toBe(false); // deleted
    expect(rows1.has("opaque-artifact")).toBe(true); // untouched
    expect(rows1.has(`${SPEC_REL}#GRT-1`)).toBe(true);
    const goodHash = rows1.get(SPEC_REL) as string;

    // corrupt the spec file row's hash → exactly one changed, restored
    const db2 = openDb(dbPath);
    db2
      .query(
        "UPDATE artifact SET content_hash = ? WHERE repo = ? AND logical_id = ?",
      )
      .run(`sha256:${"0".repeat(64)}`, REPO_KEY, SPEC_REL);
    db2.close();
    const second = await rebuild(t, dbPath);
    const r2 = IndexRebuildResult.parse(JSON.parse(second.stdout));
    expect(r2).toEqual({
      ingested: 0,
      changed: 1,
      discrepancies: 0,
      schema_version: 1,
    });
    const db3 = openDb(dbPath);
    expect(artifactRows(db3).get(SPEC_REL)).toBe(goodHash); // restored
    db3.close();

    // immediately repeated rebuild reports all zeros
    const third = await rebuild(t, dbPath);
    const r3 = IndexRebuildResult.parse(JSON.parse(third.stdout));
    expect(r3).toEqual({
      ingested: 0,
      changed: 0,
      discrepancies: 0,
      schema_version: 1,
    });

    // a syntactically broken obspec source aborts with the store unchanged
    writeFileSync(
      join(t.repo, "specs", "broken.spec.md"),
      "```obspec\nkind: clause\nid: {{{\n```\n",
    );
    const db4 = openDb(dbPath);
    const before = artifactRows(db4);
    db4.close();
    const broken = await rebuild(t, dbPath);
    expect(broken.exitCode).not.toBe(0);
    expect(broken.stderr).toContain("broken.spec.md");
    const db5 = openDb(dbPath);
    expect(artifactRows(db5)).toEqual(before);
    db5.close();
  }, 60_000);
});
