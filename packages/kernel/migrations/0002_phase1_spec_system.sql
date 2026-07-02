-- ART-5: code-side drift baseline frozen on the link; NULL only on rows
-- created before this migration (those links cannot report code_under_spec
-- until re-registered).
ALTER TABLE trace_link ADD COLUMN downstream_hash_at_link TEXT;

-- ART-4: a human override must persist who and why, not just that it happened.
ALTER TABLE drift_event ADD COLUMN resolved_by TEXT;
ALTER TABLE drift_event ADD COLUMN resolution_reason TEXT;

-- PIPE-8: structured verification report, one row per verify run.
CREATE TABLE verification_report (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  results TEXT NOT NULL,
  failure_class TEXT CHECK (failure_class IN ('code_defect', 'spec_defect', 'obligation_defect')),
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);
