-- EVP-9: the executor CHECK gains 'api'. SQLite cannot alter a CHECK in
-- place; rebuild eval_run preserving rowid order via the transient
-- eval_run_new (no triggers or indexes to recreate on this table).
CREATE TABLE eval_run_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ablate', 'compare', 'replay')),
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  config_a TEXT NOT NULL,
  config_b TEXT,
  seed INTEGER NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('claude', 'command', 'api')),
  model_versions TEXT NOT NULL,
  sandbox_profile TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
INSERT INTO eval_run_new
  SELECT id, kind, suite_id, suite_version, config_a, config_b, seed,
         executor, model_versions, sandbox_profile, manifest_hash,
         started_at, finished_at
  FROM eval_run ORDER BY rowid;
DROP TABLE eval_run;
ALTER TABLE eval_run_new RENAME TO eval_run;
