import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  detectDrift,
  type HashSource,
  hashContent,
  registerArtifact,
} from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";

export const specCodePair = (db: Database) => {
  registerArtifact(db, {
    repo: "r",
    logical_id: "docs/kelspec/w.spec.md#W-1",
    type: "spec",
    content: "clause-v1",
  });
  registerArtifact(db, {
    repo: "r",
    logical_id: "src/w.ts",
    type: "code_region",
    content: "code-v1",
    upstream: ["docs/kelspec/w.spec.md#W-1"],
  });
};

export const hashes = (
  overrides: Record<string, string | null>,
): HashSource => {
  const base: Record<string, string | null> = {
    "docs/kelspec/w.spec.md#W-1": hashContent("clause-v1"),
    "src/w.ts": hashContent("code-v1"),
    ...overrides,
  };
  return (id) => base[id] ?? null;
};

const openEvents = (db: Database) =>
  db
    .query(
      "SELECT artifact_id, direction FROM drift_event WHERE repo = 'r' AND resolution = 'open' ORDER BY direction",
    )
    .all() as { artifact_id: string; direction: string }[];

describe("ART-3: spec-code drift is detected in both directions as distinct drift events", () => {
  it("code changed under an unchanged spec clause raises code_under_spec", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    const found = detectDrift(
      db,
      "r",
      hashes({ "src/w.ts": hashContent("code-v2") }),
    );
    expect(found).toEqual([
      { artifact_id: "src/w.ts", direction: "code_under_spec" },
    ]);
    expect(openEvents(db)).toEqual([
      { artifact_id: "src/w.ts", direction: "code_under_spec" },
    ]);
    db.close();
  });

  it("spec clause changed over unchanged code raises spec_over_code", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    const found = detectDrift(
      db,
      "r",
      hashes({ "docs/kelspec/w.spec.md#W-1": hashContent("clause-v2") }),
    );
    expect(found).toEqual([
      { artifact_id: "src/w.ts", direction: "spec_over_code" },
    ]);
    expect(openEvents(db)).toEqual([
      { artifact_id: "src/w.ts", direction: "spec_over_code" },
    ]);
    db.close();
  });

  it("no drift when both sides match their link-frozen hashes", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    expect(detectDrift(db, "r", hashes({}))).toEqual([]);
    expect(openEvents(db)).toEqual([]);
    db.close();
  });

  it("a deleted code file is a code change, not an error", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    const found = detectDrift(db, "r", hashes({ "src/w.ts": null }));
    expect(found).toEqual([
      { artifact_id: "src/w.ts", direction: "code_under_spec" },
    ]);
    db.close();
  });
});
