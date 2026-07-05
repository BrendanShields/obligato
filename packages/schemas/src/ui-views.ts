import { z } from "zod";
import { ArtifactType, Authority, Tier } from "./artifacts.ts";
import { Delta, EvalRunKind, VerdictDecision } from "./eval.ts";
import { ChangelogEntry, ProposalState } from "./loop.ts";
import { IsoUtc, MicroUsd, Sha256, Ulid } from "./scalars.ts";

// UX-11: `kelson ui` API view schemas — UI-only envelopes composing the
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

export const UiTraceView = z.strictObject({
  empty_verb: EmptyVerb,
  nodes: z.array(UiTraceNode),
  edges: z.array(UiTraceEdge),
});
export type UiTraceView = z.infer<typeof UiTraceView>;
