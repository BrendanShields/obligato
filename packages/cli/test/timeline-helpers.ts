import type { Database } from "bun:sqlite";
import { appendEvent, createAgentSession, forkSession } from "@obligato/agent";
import { BudgetMonitor, ingestStepEvent, ulid } from "@obligato/kernel";
import type { SessionEventKind } from "@obligato/schemas";

export const LOCK = `sha256:${"0".repeat(64)}`;

export const stepRow = (
  sessionId: string,
  taskId: string,
  cost: number | null,
): Record<string, unknown> => ({
  id: ulid(),
  task_id: taskId,
  session_id: sessionId,
  sdlc_step: "build",
  model: "mock-m",
  effort: "medium",
  agent_id: "native",
  tokens_in: 10,
  tokens_out: 5,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  unit_prices: {},
  cost_micro_usd: cost,
  budget_tokens: 1000,
  overrun: "none",
  span_id: null,
  schema_version: 1,
});

// The UX-50/UX-52 fixture: one of each event class in a known rowid order, a
// fork with an event on it, one unpriced step_event, and one budget overrun
// keyed by the session id (AGT-11).
export const seedTimelineSession = (db: Database) => {
  const { sessionId, taskId, rootEventId } = createAgentSession(db, {
    repo: "test-repo",
    lockfile_hash: LOCK,
    harness_version: "0.0.1",
    model: "mock-m",
    system: "sys",
    auth_kind: "none",
  });
  let head = rootEventId;
  const add = (
    kind: SessionEventKind,
    payload: Record<string, unknown>,
  ): string => {
    head = appendEvent(db, {
      session_id: sessionId,
      parent_id: head,
      kind,
      payload,
    }).id;
    return head;
  };
  add("user_message", { text: "hello\nsecond line" });
  const step = add("assistant_message", {
    text: "reading",
    tool_calls: [{ id: "c1", name: "read", input: { path: "a" } }],
    usage: {
      tokens_in: 10,
      tokens_out: 5,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    },
    model: "mock-m",
    cost_micro_usd: null,
  });
  add("tool_result", {
    tool_call_id: "c1",
    name: "read",
    output: "line1\nline2",
    is_error: false,
  });
  // The budget overrun lands MID-stream (keyed by the session id, AGT-11) so
  // its `at` precedes later session events — a timestamp-interleaving
  // implementation would place it before them; UX-50 pins it last.
  const monitor = new BudgetMonitor(db, {
    taskId: sessionId,
    stepId: sessionId,
    attempt: 0,
    ruleId: "session",
    policyHash: LOCK,
    modelId: "session",
    escalationDepth: 0,
    budgetTokens: 10,
  });
  monitor.record(15); // > budget → one 1× overrun
  Bun.sleepSync(2); // strict `at` ordering for the interleave arm
  const request = add("permission_request", {
    tool_call_id: "c2",
    tool: "bash",
    arg: "rm x",
    rule: "default",
    reason: "permission:bash",
  });
  add("permission_decision", {
    request_id: request,
    decision: "deny",
    tool: "bash",
  });
  add("session_meta", { model_switch: { from: "mock-m", to: "mock-n" } });
  // A priced step on a long model id with a long preview — the UX-52 80-column
  // arm's worst case — followed by a failed tool.
  const pricedStep = add("assistant_message", {
    text: "Now I will refactor the session view builder and re-run the whole obligation suite for this clause family",
    tool_calls: [{ id: "c3", name: "bash", input: { command: "bun test" } }],
    usage: {
      tokens_in: 1200,
      tokens_out: 340,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    },
    model: "claude-sonnet-4-5-20250929",
    cost_micro_usd: 1234,
  });
  add("tool_result", {
    tool_call_id: "c3",
    name: "bash",
    output: "boom",
    is_error: true,
  });
  const { forkHead } = forkSession(db, sessionId, step);
  const onFork = appendEvent(db, {
    session_id: sessionId,
    parent_id: forkHead,
    kind: "user_message",
    payload: { text: "on the fork" },
  }).id;
  ingestStepEvent(db, stepRow(sessionId, taskId, null));
  return { sessionId, taskId, step, pricedStep, forkHead, onFork };
};
