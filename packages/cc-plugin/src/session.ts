import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  endSession,
  hashLockfile,
  openTask,
  safeIngest,
  startSession,
  ulid,
} from "@kelson/kernel";
import { parseTranscript } from "./transcript.ts";

export const HARNESS_VERSION = "0.0.1";

const EMPTY_LOCKFILE = { schema_version: 1, parent_hash: null, entries: [] };

// LOOP-7 shape: every session pins the lockfile hash it ran under.
export const pinnedLockfileHash = (root: string): string => {
  const path = join(root, "kelson.lock");
  return hashLockfile(
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : EMPTY_LOCKFILE,
  );
};

export const beginSession = (db: Database, repo: string): string =>
  startSession(db, {
    repo,
    lockfile_hash: pinnedLockfileHash(repo),
    harness_version: HARNESS_VERSION,
  });

// Budgets land Phase 3; until then a step's budget is effectively unbounded.
const PHASE0_BUDGET = Number.MAX_SAFE_INTEGER;

// TEL-1: when a session ends, emit a structured event record per step.
// Stage attribution lands Phase 3 — until then every step is 'build'.
export const finishSession = (
  db: Database,
  sessionId: string,
  transcript: string,
): { steps: number; failed: number } => {
  const session = db
    .query("SELECT repo FROM session WHERE id = ?")
    .get(sessionId) as { repo: string } | null;
  if (!session) throw new Error(`unknown session: ${sessionId}`);
  const steps = parseTranscript(transcript);
  const task = openTask(db, { repo: session.repo });
  let failed = 0;
  for (const s of steps) {
    const result = safeIngest(db, sessionId, "step", {
      id: ulid(),
      task_id: task,
      session_id: sessionId,
      sdlc_step: "build",
      model: s.model,
      effort: "medium",
      agent_id: "main",
      tokens_in: s.tokens_in,
      tokens_out: s.tokens_out,
      tokens_cache_read: s.tokens_cache_read,
      tokens_cache_write: s.tokens_cache_write,
      unit_prices: {},
      cost_micro_usd: 0,
      budget_tokens: PHASE0_BUDGET,
      overrun: "none",
      span_id: null,
      schema_version: 1,
    });
    if (!result.ok) failed++;
  }
  // Promotes only if still 'incomplete' — a safeIngest failure above has
  // already marked the session degraded, which endSession never overwrites.
  endSession(db, sessionId);
  return { steps: steps.length, failed };
};
