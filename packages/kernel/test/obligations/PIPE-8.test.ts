import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { VerificationReport } from "@kelson/schemas";
import { hashContent, registerArtifact } from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";
import { runVerify, verifyPassed } from "../../src/verify.ts";

const passingTests = () => ({ status: "passed" as const, detail: null });

const cleanRepo = (db: Database) => {
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
  return (id: string) =>
    id === "src/w.ts" ? hashContent("code-v1") : hashContent("clause-v1");
};

describe("PIPE-8: verify runs obligations, conventional tests, drift, and budget conformance, emitting a schema-valid structured report", () => {
  it("an all-green run emits a valid report and persists it", () => {
    const db = openDb(":memory:");
    const report = runVerify(db, {
      repo: "r",
      task_id: "T-1",
      obligations: [{ clause_id: "W-1", run: () => true }],
      runTests: passingTests,
      hashSource: cleanRepo(db),
    });
    expect(VerificationReport.safeParse(report).success).toBe(true);
    expect(verifyPassed(report)).toBe(true);
    expect(report.results.budget.status).toBe("skipped");
    const row = db
      .query("SELECT results FROM verification_report WHERE id = ?")
      .get(report.id) as { results: string };
    expect(JSON.parse(row.results)).toEqual(report.results);
    db.close();
  });

  it("failure class: a falsified obligation fails the report", () => {
    const db = openDb(":memory:");
    const report = runVerify(db, {
      repo: "r",
      task_id: "T-1",
      obligations: [
        {
          clause_id: "W-1",
          run: () => ({ ok: false, detail: "property falsified" }),
        },
        { clause_id: "W-2", run: () => true },
      ],
      runTests: passingTests,
    });
    expect(report.results.obligations).toEqual([
      { clause_id: "W-1", status: "failed", detail: "property falsified" },
      { clause_id: "W-2", status: "passed", detail: null },
    ]);
    expect(verifyPassed(report)).toBe(false);
    db.close();
  });

  it("failure class: a throwing obligation fails with its message", () => {
    const db = openDb(":memory:");
    const report = runVerify(db, {
      repo: "r",
      task_id: "T-1",
      obligations: [
        {
          clause_id: "W-1",
          run: () => {
            throw new Error("harness exploded");
          },
        },
      ],
      runTests: passingTests,
    });
    expect(report.results.obligations[0]?.status).toBe("failed");
    expect(report.results.obligations[0]?.detail).toBe("harness exploded");
    db.close();
  });

  it("failure class: conventional test failure fails the report", () => {
    const db = openDb(":memory:");
    const report = runVerify(db, {
      repo: "r",
      task_id: "T-1",
      obligations: [],
      runTests: () => ({ status: "failed", detail: "2 tests failed" }),
    });
    expect(verifyPassed(report)).toBe(false);
    db.close();
  });

  it("failure class: open drift fails the report; no hash source is skipped, not green", () => {
    const db = openDb(":memory:");
    const clean = cleanRepo(db);
    const drifted = runVerify(db, {
      repo: "r",
      task_id: "T-1",
      obligations: [],
      runTests: passingTests,
      hashSource: (id) =>
        id === "src/w.ts" ? hashContent("code-v2") : clean(id),
    });
    expect(drifted.results.drift.status).toBe("failed");
    expect(drifted.results.drift.open_events).toBeGreaterThan(0);
    expect(verifyPassed(drifted)).toBe(false);

    const blind = runVerify(db, {
      repo: "r",
      task_id: "T-2",
      obligations: [],
      runTests: passingTests,
    });
    expect(blind.results.drift.status).toBe("skipped");
    db.close();
  });
});
