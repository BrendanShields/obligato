import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AdvisoryReason,
  type Executor,
  ReplayRecord,
  type SandboxProfile,
} from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import {
  type Lockfileish,
  loadSuite,
  materializeClaudeSide,
} from "./evalrun.ts";
import { EXECUTORS, type ExecutorFn, runTask } from "./evaltask.ts";
import { canonicalJson, hashLockfile } from "./packs.ts";
import { createWorkspace } from "./sandbox.ts";
import { DEFAULT_SNAPSHOT_DIR } from "./snapshots.ts";
import { type PairedResult, replayVeto } from "./stats.ts";
import { ulid } from "./ulid.ts";

// EVP §4 rule 1: the bundle must restore bit-identically.
export const verifySnapshot = (hash: string, storeDir: string): boolean => {
  const path = join(storeDir, `${hash.replace("sha256:", "")}.bundle`);
  if (!existsSync(path)) return false;
  return hashContent(readFileSync(path)) === hash;
};

export interface ReplayValidityInput {
  snapshotHash: string;
  storeDir: string;
  originalStatus: "complete" | "incomplete" | "degraded";
  originalModels: string[];
  candidateModels: string[];
}

// EVP-3: the three validity rules; any failure → advisory, never gate math.
export const validateReplay = (
  input: ReplayValidityInput,
): { validity: "valid" | "advisory"; reason: AdvisoryReason | null } => {
  if (!verifySnapshot(input.snapshotHash, input.storeDir))
    return { validity: "advisory", reason: "snapshot_hash_mismatch" };
  if (input.originalStatus !== "complete")
    return { validity: "advisory", reason: "source_session_not_complete" };
  const same =
    input.originalModels.length === input.candidateModels.length &&
    input.originalModels.every((m) => input.candidateModels.includes(m));
  // Cross-model replays inform, never gate — advisory either way on mismatch.
  if (!same) return { validity: "advisory", reason: "model_mismatch" };
  return { validity: "valid", reason: null };
};

export const recordReplay = (
  db: Database,
  record: Omit<ReplayRecord, "id" | "at" | "schema_version">,
): ReplayRecord => {
  const full = ReplayRecord.parse({
    ...record,
    id: ulid(),
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.query(
    `INSERT INTO replay_record (id, source_session_id, snapshot_ref, config, run_id, outcome, validity, advisory_reason, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.source_session_id,
    full.snapshot_ref,
    full.config,
    full.run_id,
    JSON.stringify(full.outcome),
    full.validity,
    full.advisory_reason,
    full.at,
    full.schema_version,
  );
  return full;
};

export interface ReplayRunOptions {
  sessionId: string;
  suiteDir: string;
  lockfile: Lockfileish;
  profile: SandboxProfile;
  executor: Executor;
  // EVP-3: without a declared model the replay's model is unknown — never
  // guessed (PROV-3) — so validity degrades to a model_mismatch advisory.
  model?: string;
  snapshotStoreDir?: string;
  extraExecutors?: Partial<Record<Executor, ExecutorFn>>;
}

// UX-23: re-run a promoted session's benchmark task under a candidate config
// and record the replay_record linking source session and replay run. The
// replay deliberately writes NO eval_task_result rows — those pool into the
// EVP-5 flakiness windows per (task, config), which a counterfactual re-run
// must not pollute (same fence rationale as bench, EVP-11).
export const runReplay = async (
  db: Database,
  opts: ReplayRunOptions,
): Promise<ReplayRecord> => {
  const { suite, tasks } = loadSuite(opts.suiteDir);
  const taskId = `session-${opts.sessionId.toLowerCase()}`;
  const task = tasks.find((t) => t.id === taskId);
  if (!task)
    throw new Error(
      `session ${opts.sessionId} has no promoted benchmark task in ${opts.suiteDir} — run \`kelson promote <session> --suite <dir>\` first (UX-23)`,
    );
  const fn = { ...EXECUTORS, ...opts.extraExecutors }[opts.executor];
  if (!fn)
    throw new Error(
      `executor "${opts.executor}" is not resolvable in this invocation — the CLI injects it via extraExecutors (EVP-9)`,
    );

  const session = db
    .query("SELECT status FROM session WHERE id = ?")
    .get(opts.sessionId) as {
    status: "complete" | "incomplete" | "degraded";
  } | null;
  // The original session ran outside eval scoring: complete is the only
  // recorded success signal, and step costs are its recorded spend.
  const originalStatus = session?.status ?? "incomplete";
  const originalModels = (
    db
      .query(
        "SELECT DISTINCT model FROM step_event WHERE session_id = ? ORDER BY model",
      )
      .all(opts.sessionId) as { model: string }[]
  ).map((r) => r.model);
  const originalCost = (
    db
      .query(
        "SELECT COALESCE(SUM(cost_micro_usd), 0) AS c FROM step_event WHERE session_id = ?",
      )
      .get(opts.sessionId) as { c: number }
  ).c;

  const config = hashLockfile(opts.lockfile);
  const runId = ulid();
  const storeDir = opts.snapshotStoreDir ?? DEFAULT_SNAPSHOT_DIR;
  const manifestHash = hashContent(
    canonicalJson({
      kind: "replay",
      source_session_id: opts.sessionId,
      task: task.id,
      snapshot: task.snapshot,
      config,
      executor: opts.executor,
      model: opts.model ?? null,
    }),
  );
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at)
     VALUES (?, 'replay', ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    suite.id,
    suite.version,
    config,
    opts.executor,
    JSON.stringify(opts.model ? { session_model: opts.model } : {}),
    JSON.stringify(opts.profile),
    manifestHash,
    new Date().toISOString(),
  );

  let outcome: Awaited<ReturnType<typeof runTask>>;
  try {
    const ws = createWorkspace(opts.profile, {
      snapshot: task.snapshot,
      storeDir,
    });
    try {
      if (opts.executor === "claude")
        materializeClaudeSide(ws.dir, opts.lockfile);
      outcome = await runTask(task, ws, fn, {
        KELSON_SEED: "0",
        KELSON_ENABLED_PACKS: opts.lockfile.entries
          .filter((e) => e.enabled)
          .map((e) => e.name)
          .join(","),
        ...(opts.model ? { ANTHROPIC_MODEL: opts.model } : {}),
      });
    } finally {
      ws.cleanup();
    }
  } finally {
    // UX-23: a failed replay still finishes its run row — a dangling
    // finished_at NULL renders as forever-running in the eval view.
    db.query("UPDATE eval_run SET finished_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      runId,
    );
  }

  const { validity, reason } = validateReplay({
    snapshotHash: task.snapshot,
    storeDir,
    originalStatus,
    originalModels,
    candidateModels: opts.model ? [opts.model] : [],
  });
  return recordReplay(db, {
    source_session_id: opts.sessionId,
    snapshot_ref: task.snapshot,
    config,
    run_id: runId,
    outcome: {
      fpar_pass: outcome.fpar_pass,
      cost_micro_usd: outcome.cost_micro_usd,
      original_fpar_pass: originalStatus === "complete",
      original_cost_micro_usd: originalCost,
    },
    validity,
    advisory_reason: reason,
  });
};

export interface ReplayAggregate {
  vetoed: boolean;
  decision: string;
  valid_n: number;
  advisory_n: number;
  session_ids: string[];
}

// EVAL-5 + EVP §5.1: replays pair each task against its own original
// outcome; advisory records are reported but excluded from gate math.
export const aggregateReplays = (
  db: Database,
  config: string,
): ReplayAggregate => {
  const rows = db
    .query("SELECT * FROM replay_record WHERE config = ? ORDER BY rowid")
    .all(config) as Record<string, unknown>[];
  const records = rows.map((r) =>
    ReplayRecord.parse({ ...r, outcome: JSON.parse(r.outcome as string) }),
  );
  const valid = records.filter((r) => r.validity === "valid");
  const pairs: PairedResult[] = valid.map((r) => ({
    task_id: r.source_session_id,
    fpar_a: r.outcome.fpar_pass ? 1 : 0,
    fpar_b: r.outcome.original_fpar_pass ? 1 : 0,
    cost_a: r.outcome.cost_micro_usd,
    cost_b: r.outcome.original_cost_micro_usd,
  }));
  const { vetoed, outcome } = replayVeto(pairs);
  return {
    vetoed,
    decision: outcome.decision,
    valid_n: valid.length,
    advisory_n: records.length - valid.length,
    session_ids: valid.map((r) => r.source_session_id),
  };
};
