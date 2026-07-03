import type { Database } from "bun:sqlite";
import { openTask, startSession, storeSnapshot, ulid } from "@kelson/kernel";
import { SessionEvent, type SessionEventKind } from "@kelson/schemas";

export class SessionNotPausedError extends Error {
  constructor(actual: string) {
    super(`resume requires a paused session; state is "${actual}" (AGT-5)`);
  }
}

const insertEvent = (db: Database, e: SessionEvent): void => {
  db.query(
    `INSERT INTO session_event (id, session_id, parent_id, kind, payload, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.session_id,
    e.parent_id,
    e.kind,
    JSON.stringify(e.payload),
    e.at,
    e.schema_version,
  );
};

// SES-3: appending moves the head via a head_moved event (parent_id null —
// head pointers live off-chain); the current head is derived by rowid.
export const appendEvent = (
  db: Database,
  args: {
    session_id: string;
    parent_id: string | null;
    kind: SessionEventKind;
    payload: Record<string, unknown>;
  },
): SessionEvent => {
  const event = SessionEvent.parse({
    id: ulid(),
    session_id: args.session_id,
    parent_id: args.parent_id,
    kind: args.kind,
    payload: args.payload,
    at: new Date().toISOString(),
    schema_version: 1,
  });
  const head = SessionEvent.parse({
    id: ulid(),
    session_id: args.session_id,
    parent_id: null,
    kind: "head_moved",
    payload: { head_event_id: event.id, reason: "append" },
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.transaction(() => {
    insertEvent(db, event);
    insertEvent(db, head);
  })();
  return event;
};

const rowToEvent = (row: Record<string, unknown>): SessionEvent =>
  SessionEvent.parse({
    ...row,
    payload: JSON.parse(row.payload as string),
  });

export const listEvents = (db: Database, sessionId: string): SessionEvent[] =>
  (
    db
      .query("SELECT * FROM session_event WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Record<string, unknown>[]
  ).map(rowToEvent);

export const currentHead = (events: SessionEvent[]): string | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "head_moved")
      return (e.payload.head_event_id as string) ?? null;
  }
  return null;
};

// SES-2/6: walk the parent chain from a GIVEN head -> root, reversed. Used for
// arbitrary branch heads (SES-7 compare) as well as the current head. head_moved
// events are off-chain by construction (their ids are never a parent_id).
// SES-8: if the walked chain carries a compaction marker, the covered prefix is
// replaced by a single synthetic summary user_message (the covered originals
// stay in the store; only the reconstructed context substitutes).
export const reconstructFrom = (
  events: SessionEvent[],
  headId: string | null,
): SessionEvent[] => {
  if (headId === null) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain: SessionEvent[] = [];
  let cursor = byId.get(headId);
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  chain.reverse();
  const comp = [...chain]
    .reverse()
    .find((e) => e.kind === "session_meta" && e.payload.compaction);
  if (!comp) return chain;
  const { summary, to_event } = comp.payload.compaction as {
    summary: string;
    to_event: string;
  };
  const toIdx = chain.findIndex((e) => e.id === to_event);
  if (toIdx < 0) return chain;
  const summaryEvent = SessionEvent.parse({
    // Deterministic (SES-2) synthetic id: flip the first Crockford char of the
    // compaction event's ULID so it is a valid, stable, distinct id.
    id: (comp.id[0] === "0" ? "1" : "0") + comp.id.slice(1),
    session_id: comp.session_id,
    parent_id: null,
    kind: "user_message",
    payload: { text: summary, compacted: true },
    at: comp.at,
    schema_version: 1,
  });
  return [summaryEvent, ...chain.slice(toIdx + 1)];
};

export const reconstruct = (events: SessionEvent[]): SessionEvent[] =>
  reconstructFrom(events, currentHead(events));

export type Lifecycle = "active" | "paused" | "done";

interface ChainToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Tool calls on the last assistant message with no tool_result yet — the
// suspended remainder of an interrupted step.
export const pendingToolCalls = (chain: SessionEvent[]): ChainToolCall[] => {
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  if (!lastAssistant) return [];
  const calls = (lastAssistant.payload.tool_calls ?? []) as ChainToolCall[];
  const resolved = new Set(
    chain
      .filter((e) => e.kind === "tool_result")
      .map((e) => String(e.payload.tool_call_id)),
  );
  return calls.filter((c) => !resolved.has(c.id));
};

// AGT-6 (amended with the audit): paused = the turn is suspended mid-flight —
// the last assistant message requested tools, whether results are pending
// (permission ask) or all landed (step_limit / crash between steps). done =
// it requested none. active = no assistant message yet. No pause event kind.
export const lifecycle = (chain: SessionEvent[]): Lifecycle => {
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  if (!lastAssistant) return "active";
  const toolCalls = (lastAssistant.payload.tool_calls ?? []) as unknown[];
  return toolCalls.length === 0 ? "done" : "paused";
};

export const assertResumable = (chain: SessionEvent[]): void => {
  const state = lifecycle(chain);
  if (state !== "paused") throw new SessionNotPausedError(state);
};

// UX-17 (divergence-pinned): the active model derives from the chain — the
// last model_switch wins, else the session's starting model. Never re-reads
// the config default.
export const sessionModelOf = (chain: SessionEvent[]): string | null => {
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if (e?.kind !== "session_meta") continue;
    const sw = e.payload.model_switch as { to?: string } | undefined;
    if (sw?.to) return sw.to;
    if (e.payload.model) return String(e.payload.model);
  }
  return null;
};

// UX-17: one session event per switch; same-model switches are the caller's
// no-op (nothing appended here by contract). Refuses when invoked with a
// stale expected head — a switch appended mid-step would orphan off the
// reconstructed chain (audit F-088 class; the TUI's serialized turns make
// this unreachable, but the exported API guards it).
export const appendModelSwitch = (
  db: Database,
  sessionId: string,
  from: string,
  to: string,
  expectedHead?: string,
): SessionEvent => {
  const chain = reconstruct(listEvents(db, sessionId));
  const head = chain[chain.length - 1];
  if (!head) throw new Error("session has no events");
  if (expectedHead !== undefined && head.id !== expectedHead)
    throw new Error(
      "model switch raced the session head — the chain moved under it (UX-17)",
    );
  return appendEvent(db, {
    session_id: sessionId,
    parent_id: head.id,
    kind: "session_meta",
    payload: { model_switch: { from, to } },
  });
};

export interface AgentSession {
  sessionId: string;
  taskId: string;
  rootEventId: string;
}

// SES-4: --continue loads an existing session's head and extends the chain.
export const continueSession = (
  db: Database,
  sessionId: string,
): { sessionId: string; head: string } => {
  const events = listEvents(db, sessionId);
  const head = currentHead(events);
  if (head === null)
    throw new Error(`no session ${sessionId} in the store (SES-4)`);
  return { sessionId, head };
};

// SES-4: native sessions get a kernel session row (TEL-5 markers, LOOP-7
// lockfile pinning) plus a task row for step-event attribution.
export const createAgentSession = (
  db: Database,
  args: {
    repo: string;
    lockfile_hash: string;
    harness_version: string;
    model: string;
    system: string;
    // PROV-6: how the session authenticates; ledger/degradation policy reads
    // this — required so every creator states it.
    auth_kind: "subscription" | "api_key" | "none";
    // EVP-10: where session-start git-bundle snapshots are stored (a promotable
    // session needs one). Omit to use the kernel default.
    snapshot_store_dir?: string;
  },
): AgentSession => {
  const sessionId = startSession(db, {
    runner: "native",
    repo: args.repo,
    lockfile_hash: args.lockfile_hash,
    harness_version: args.harness_version,
  });
  const taskId = openTask(db, { repo: args.repo });
  // EVP-10: best-effort snapshot — null when the repo is not a git working
  // tree (a plain chat dir); promotion later requires a non-null one.
  let snapshot: string | null = null;
  try {
    snapshot = storeSnapshot(args.repo, args.snapshot_store_dir);
  } catch {
    snapshot = null;
  }
  const root = appendEvent(db, {
    session_id: sessionId,
    parent_id: null,
    kind: "session_meta",
    payload: {
      task_id: taskId,
      model: args.model,
      system: args.system,
      runner: "native",
      auth_kind: args.auth_kind,
      snapshot,
    },
  });
  return { sessionId, taskId, rootEventId: root.id };
};

// SES-6: fork a session at an event (default: current head). Appends an inert
// fork marker parented at the target — appendEvent's head_moved makes it the
// new current head, so both branches' heads coexist (SES-3). Returns the fork
// head and the pre-fork original head (recoverable, append-only).
export const forkSession = (
  db: Database,
  sessionId: string,
  eventId?: string,
): { forkHead: string; originalHead: string } => {
  const events = listEvents(db, sessionId);
  const originalHead = currentHead(events);
  if (originalHead === null)
    throw new Error(`no session ${sessionId} in the store (SES-6)`);
  const target = eventId ?? originalHead;
  if (!events.some((e) => e.id === target))
    throw new Error(`no event ${target} in session ${sessionId} (SES-6)`);
  const marker = appendEvent(db, {
    session_id: sessionId,
    parent_id: target,
    kind: "session_meta",
    payload: { forked_from: target },
  });
  return { forkHead: marker.id, originalHead };
};

export interface BranchSummary {
  head: string;
  cost_micro_usd: number;
  last_text: string;
  lifecycle: Lifecycle;
  event_count: number;
}

export interface BranchComparison {
  common_ancestor: string | null;
  shared_prefix: number;
  a: BranchSummary;
  b: BranchSummary;
}

// SES-7: read-only compare of two branch heads — per-branch cost + outcome and
// the deepest common ancestor. Appends nothing.
export const compareBranches = (
  db: Database,
  sessionId: string,
  headA: string,
  headB: string,
): BranchComparison => {
  const events = listEvents(db, sessionId);
  const summarize = (head: string): BranchSummary => {
    const chain = reconstructFrom(events, head);
    const assistants = chain.filter((e) => e.kind === "assistant_message");
    return {
      head,
      cost_micro_usd: assistants.reduce(
        (sum, e) => sum + Number(e.payload.cost_micro_usd ?? 0),
        0,
      ),
      last_text: String(assistants.at(-1)?.payload.text ?? ""),
      lifecycle: lifecycle(chain),
      event_count: chain.length,
    };
  };
  const chainA = reconstructFrom(events, headA);
  const idsB = new Set(reconstructFrom(events, headB).map((e) => e.id));
  let common: string | null = null;
  let shared = 0;
  for (const e of chainA) {
    if (idsB.has(e.id)) {
      common = e.id;
      shared++;
    } else break;
  }
  return {
    common_ancestor: common,
    shared_prefix: shared,
    a: summarize(headA),
    b: summarize(headB),
  };
};

// SES-8: compact the reconstructed chain to head — summarize (caller supplies
// the summarizer, a cheap routed model in production) and append one compaction
// marker covering [root, head]. The covered originals are never deleted; only
// reconstruction substitutes the summary (reconstructFrom).
export const compactSession = (
  db: Database,
  sessionId: string,
  summarize: (chain: SessionEvent[]) => string,
): { from_event: string; to_event: string } => {
  const events = listEvents(db, sessionId);
  const head = currentHead(events);
  if (head === null)
    throw new Error(`no session ${sessionId} in the store (SES-8)`);
  const chain = reconstructFrom(events, head);
  // Resolve `from` to the first REAL covered event — on a re-compact chain[0]
  // is the prior compaction's synthetic (in-memory) summary, not a stored id.
  const realIds = new Set(events.map((e) => e.id));
  const from = chain.find((e) => realIds.has(e.id)) ?? chain[0];
  if (!from) throw new Error(`session ${sessionId} has no events (SES-8)`);
  const summary = summarize(chain);
  appendEvent(db, {
    session_id: sessionId,
    parent_id: head,
    kind: "session_meta",
    payload: {
      compaction: { summary, from_event: from.id, to_event: head },
    },
  });
  return { from_event: from.id, to_event: head };
};

export const authKindOf = (
  credential: { type: string } | null,
): "subscription" | "api_key" | "none" =>
  credential === null
    ? "none"
    : credential.type === "api_key"
      ? "api_key"
      : "subscription";
