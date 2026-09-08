import { z } from "zod";
import { ArtifactType, Authority, Tier } from "./artifacts.ts";
import { BenchTaskRow } from "./cli.ts";
import { Delta, EvalRunKind, Executor, VerdictDecision } from "./eval.ts";
import { ChangelogEntry, ProposalState } from "./loop.ts";
import { IsoUtc, MicroUsd, Sha256, Ulid } from "./scalars.ts";
import { SessionStatus } from "./telemetry.ts";

// UX-11: `obligato ui` API view schemas — UI-only envelopes composing the
// CLI/kernel schemas by reference. UX-12: every view carries `empty_verb`,
// the CLI command that produces its data.
const EmptyVerb = z.string().min(1);

export const UiSessionRow = z.strictObject({
  id: Ulid,
  repo: z.string().min(1),
  status: z.enum(["complete", "incomplete", "degraded"]),
  started_at: IsoUtc,
  ended_at: IsoUtc.nullable(),
  steps: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  cost_micro_usd: MicroUsd,
});
export type UiSessionRow = z.infer<typeof UiSessionRow>;

export const UiSeriesPoint = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokens: z.number().int().nonnegative(),
  cost_micro_usd: MicroUsd,
});
export type UiSeriesPoint = z.infer<typeof UiSeriesPoint>;

export const UiTelemetryView = z.strictObject({
  empty_verb: EmptyVerb,
  sessions_count: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_micro_usd: MicroUsd,
  models: z.array(
    z.strictObject({
      model: z.string().min(1),
      steps: z.number().int().positive(),
    }),
  ),
  series: z.array(UiSeriesPoint),
  sessions: z.array(UiSessionRow),
});
export type UiTelemetryView = z.infer<typeof UiTelemetryView>;

export const UiEvalRunRow = z.strictObject({
  id: Ulid,
  kind: EvalRunKind,
  suite_id: z.string().min(1),
  suite_version: z.string().min(1),
  started_at: IsoUtc,
  finished_at: IsoUtc.nullable(),
  decision: VerdictDecision.nullable(),
  fpar_delta: Delta.nullable(),
  cost_delta_pct: Delta.nullable(),
  n: z.number().int().nonnegative().nullable(),
});
export type UiEvalRunRow = z.infer<typeof UiEvalRunRow>;

export const UiEvalView = z.strictObject({
  empty_verb: EmptyVerb,
  runs: z.array(UiEvalRunRow),
});
export type UiEvalView = z.infer<typeof UiEvalView>;

export const UiProposalRow = z.strictObject({
  id: Ulid,
  target_pack: z.string().min(1),
  state: ProposalState,
  created_by: z.enum(["loop", "human"]),
  rationale: z.string(),
  created_at: IsoUtc,
  updated_at: IsoUtc,
});
export type UiProposalRow = z.infer<typeof UiProposalRow>;

export const UiLoopView = z.strictObject({
  empty_verb: EmptyVerb,
  proposals: z.array(UiProposalRow),
  changelog: z.array(ChangelogEntry),
});
export type UiLoopView = z.infer<typeof UiLoopView>;

export const UiTraceNode = z.strictObject({
  logical_id: z.string().min(1),
  type: ArtifactType,
  authority: Authority,
  tier: Tier,
  content_hash: Sha256,
  drift_open: z.boolean(),
});
export type UiTraceNode = z.infer<typeof UiTraceNode>;

export const UiTraceEdge = z.strictObject({
  upstream_id: z.string().min(1),
  downstream_id: z.string().min(1),
});
export type UiTraceEdge = z.infer<typeof UiTraceEdge>;

// UX-25: bench runs in the web eval surface — per-task rows compose the CLI
// BenchTaskRow by reference (UX-11 discipline).
export const UiBenchRunRow = z.strictObject({
  id: Ulid,
  suite_id: z.string().min(1),
  suite_version: z.string().min(1),
  candidate: Executor,
  baseline: Executor,
  started_at: IsoUtc,
  finished_at: IsoUtc.nullable(),
  decision: VerdictDecision.nullable(),
  fpar_delta: Delta.nullable(),
  cost_delta_pct: Delta.nullable(),
  n: z.number().int().nonnegative().nullable(),
  rows: z.array(BenchTaskRow),
});
export type UiBenchRunRow = z.infer<typeof UiBenchRunRow>;

export const UiBenchView = z.strictObject({
  empty_verb: EmptyVerb,
  runs: z.array(UiBenchRunRow),
});
export type UiBenchView = z.infer<typeof UiBenchView>;

export const UiTraceView = z.strictObject({
  empty_verb: EmptyVerb,
  nodes: z.array(UiTraceNode),
  edges: z.array(UiTraceEdge),
});
export type UiTraceView = z.infer<typeof UiTraceView>;

// UX-50: per-session timeline — header + the rowid-ordered event stream
// mapped totally to item variants, then the session's budget events.
const Count = z.number().int().nonnegative();

export const UiSessionHeader = z.strictObject({
  id: Ulid,
  repo: z.string().min(1),
  status: SessionStatus,
  runner: z.enum(["cc", "native"]).nullable(),
  model: z.string().nullable(),
  auth_kind: z.string().nullable(),
  started_at: IsoUtc,
  ended_at: IsoUtc.nullable(),
  steps: Count,
  tokens: Count,
  // PROV-3: null when any step is unpriced — never a partial sum.
  cost_micro_usd: MicroUsd.nullable(),
  unpriced_steps: Count,
});
export type UiSessionHeader = z.infer<typeof UiSessionHeader>;

const itemBase = {
  seq: z.number().int().positive(),
  id: Ulid,
  at: IsoUtc,
};

export const UiSessionItem = z.discriminatedUnion("kind", [
  z.strictObject({ ...itemBase, kind: z.literal("user"), preview: z.string() }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("step"),
    model: z.string().min(1),
    tokens_in: Count,
    tokens_out: Count,
    tokens_cache_read: Count,
    tokens_cache_write: Count,
    cost_micro_usd: MicroUsd.nullable(),
    tool_calls: Count,
    preview: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("tool"),
    name: z.string().min(1),
    ok: z.boolean(),
    detail: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("permission"),
    phase: z.enum(["request", "decision"]),
    tool: z.string(),
    detail: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("compaction"),
    from_event: z.string(),
    to_event: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("model_switch"),
    from: z.string(),
    to: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("escalation"),
    model: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("obligation"),
    clause_id: z.string(),
    status: z.enum(["pass", "fail"]),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("fork"),
    from_event: z.string(),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("meta"),
    keys: z.array(z.string()),
  }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("budget"),
    event: z.enum(["overrun", "triage_requested", "triage_resolved"]),
    detail: z.string(),
  }),
]);
export type UiSessionItem = z.infer<typeof UiSessionItem>;

export const UiSessionView = z.strictObject({
  empty_verb: EmptyVerb,
  session: UiSessionHeader.nullable(),
  items: z.array(UiSessionItem),
});
export type UiSessionView = z.infer<typeof UiSessionView>;

// UX-51: palette search hits — every hit names the CLI verb that acts on it.
export const UiSearchHit = z.strictObject({
  kind: z.enum(["session", "eval_run", "proposal", "divergence", "clause"]),
  id: z.string().min(1),
  label: z.string(),
  command: z.string().min(1),
});
export type UiSearchHit = z.infer<typeof UiSearchHit>;

export const UiSearchView = z.strictObject({
  empty_verb: EmptyVerb,
  query: z.string(),
  hits: z.array(UiSearchHit).max(50),
});
export type UiSearchView = z.infer<typeof UiSearchView>;
