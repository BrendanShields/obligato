import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Artifact } from "@obligato/schemas";
import {
  buildGate,
  detectDrift,
  hashContent,
  registerArtifact,
} from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";

const CLAUSE = "docs/obspec/w.spec.md#W-1";

const staleClause = (
  db: Database,
  authority: Artifact["authority"],
  tier: Artifact["tier"],
) => {
  registerArtifact(db, {
    repo: "r",
    logical_id: CLAUSE,
    type: "spec",
    content: "clause-v1",
    authority,
    tier,
  });
  registerArtifact(db, {
    repo: "r",
    logical_id: "src/w.ts",
    type: "code_region",
    content: "code-v1",
    upstream: [CLAUSE],
  });
  const inserted = detectDrift(db, "r", (id) =>
    id === "src/w.ts" ? hashContent("code-v2") : hashContent("clause-v1"),
  );
  expect(inserted).toHaveLength(1);
};

describe("ART-4: stale non-inferred blocks at T1+, warns at T0; stale-inferred alerts only; a recorded override unblocks with attribution", () => {
  it("stale authored and confirmed clauses at T1 block the build step", () => {
    for (const authority of ["authored", "confirmed"] as const) {
      const db = openDb(":memory:");
      staleClause(db, authority, "T1");
      const gate = buildGate(db, "r", [CLAUSE]);
      expect(gate.action).toBe("block");
      expect(gate.stale.map((s) => s.clause_id)).toEqual([CLAUSE]);
      db.close();
    }
  });

  it("stale confirmed clause at T0 warns and proceeds", () => {
    const db = openDb(":memory:");
    staleClause(db, "confirmed", "T0");
    expect(buildGate(db, "r", [CLAUSE]).action).toBe("warn");
    db.close();
  });

  it("stale inferred clause proceeds with an alert at any tier", () => {
    for (const tier of ["T0", "T1", "T2"] as const) {
      const db = openDb(":memory:");
      staleClause(db, "inferred", tier);
      const gate = buildGate(db, "r", [CLAUSE]);
      expect(gate.action).toBe("proceed");
      expect(gate.alerts.some((a) => a.includes(CLAUSE))).toBe(true);
      db.close();
    }
  });

  it("a recorded human override unblocks and is persisted on the drift events", () => {
    const db = openDb(":memory:");
    staleClause(db, "confirmed", "T2");
    const gate = buildGate(db, "r", [CLAUSE], {
      by: "brendan",
      reason: "spec repair scheduled next task",
    });
    expect(gate.action).toBe("proceed");
    expect(gate.overridden).toBe(true);
    const rows = db
      .query(
        "SELECT resolution, resolved_at, resolved_by, resolution_reason FROM drift_event WHERE repo = 'r'",
      )
      .all() as {
      resolution: string;
      resolved_at: string | null;
      resolved_by: string | null;
      resolution_reason: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.resolution).toBe("overridden");
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_by).toBe("brendan");
      expect(row.resolution_reason).toBe("spec repair scheduled next task");
    }
    db.close();
  });

  it("untouched or clean clauses proceed", () => {
    const db = openDb(":memory:");
    registerArtifact(db, {
      repo: "r",
      logical_id: CLAUSE,
      type: "spec",
      content: "clause-v1",
      authority: "confirmed",
      tier: "T2",
    });
    expect(buildGate(db, "r", [CLAUSE]).action).toBe("proceed");
    expect(buildGate(db, "r", []).action).toBe("proceed");
    db.close();
  });
});
