import { describe, expect, it } from "bun:test";
import { detectDrift, hashContent } from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";
import { hashes, specCodePair } from "./ART-3.test.ts";

describe("ART-5: drift is evaluated against link-frozen hashes; open events dedup; index re-sync never erases pending drift", () => {
  it("an artifact-index re-sync between a code edit and detection does not erase pending code_under_spec drift", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    // The re-sync an index rebuild would perform: current hash moves to the
    // edited content before detection ever ran.
    db.query(
      "UPDATE artifact SET content_hash = ? WHERE repo = 'r' AND logical_id = 'src/w.ts'",
    ).run(hashContent("code-v2"));
    const found = detectDrift(
      db,
      "r",
      hashes({ "src/w.ts": hashContent("code-v2") }),
    );
    expect(found).toEqual([
      { artifact_id: "src/w.ts", direction: "code_under_spec" },
    ]);
    db.close();
  });

  it("both-changed yields two rows on one link, both anchored on the downstream artifact", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    const found = detectDrift(
      db,
      "r",
      hashes({
        "docs/obspec/w.spec.md#W-1": hashContent("clause-v2"),
        "src/w.ts": hashContent("code-v2"),
      }),
    );
    expect(found.map((f) => f.direction).sort()).toEqual([
      "code_under_spec",
      "spec_over_code",
    ]);
    expect(new Set(found.map((f) => f.artifact_id))).toEqual(
      new Set(["src/w.ts"]),
    );
    db.close();
  });

  it("re-detection while an event is open inserts nothing", () => {
    const db = openDb(":memory:");
    specCodePair(db);
    const source = hashes({ "src/w.ts": hashContent("code-v2") });
    expect(detectDrift(db, "r", source)).toHaveLength(1);
    expect(detectDrift(db, "r", source)).toEqual([]);
    const rows = db
      .query("SELECT COUNT(*) AS n FROM drift_event WHERE repo = 'r'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });
});
