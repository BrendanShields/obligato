import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { openDb } from "../../src/storage.ts";
import { ingestInterventionEvent } from "../../src/telemetry.ts";
import { ulid } from "../../src/ulid.ts";

const HASH = `sha256:${"a".repeat(64)}`;

const seedTask = (db: Database): string => {
  const id = ulid();
  db.query(
    "INSERT INTO task (id, repo, state, opened_at) VALUES (?, 'r', 'open', '2026-01-01T00:00:00Z')",
  ).run(id);
  return id;
};

const correctionCount = (db: Database, taskId: string): number =>
  (
    db
      .query("SELECT correction_count AS c FROM task WHERE id = ?")
      .get(taskId) as { c: number }
  ).c;

const intervention = (
  taskId: string,
  cls: "correction" | "clarification" | "approval",
) => ({
  id: ulid(),
  task_id: taskId,
  session_id: ulid(),
  class: cls,
  artifact_hash: HASH,
  at: "2026-01-01T00:00:00Z",
  schema_version: 1,
});

describe("TEL-4: intervention storage links the artifact hash; correction-class increments correction_count", () => {
  it("a correction increments correction_count and links its artifact hash; clarification/approval leave it unchanged", () => {
    const db = openDb(":memory:");
    const taskId = seedTask(db);
    expect(correctionCount(db, taskId)).toBe(0);

    ingestInterventionEvent(db, intervention(taskId, "correction"));
    expect(correctionCount(db, taskId)).toBe(1);

    ingestInterventionEvent(db, intervention(taskId, "clarification"));
    ingestInterventionEvent(db, intervention(taskId, "approval"));
    // Only the correction moved the counter that feeds the correction-rate metric.
    expect(correctionCount(db, taskId)).toBe(1);

    const rows = db
      .query(
        "SELECT class, artifact_hash FROM intervention_event WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId) as { class: string; artifact_hash: string | null }[];
    expect(rows.map((r) => r.class)).toEqual([
      "correction",
      "clarification",
      "approval",
    ]);
    expect(rows[0]?.artifact_hash).toBe(HASH);
    db.close();
  });
});
