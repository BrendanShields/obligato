// UX-30/UX-31: pure view-model for the chat cockpit — segment arrays with
// color ROLES (never hex; resolution happens at the render edge via
// resolveColor, UX-29). Headlessly testable; no OpenTUI imports.

import {
  type ChatModel,
  foldableIndices,
  isFoldable,
  lineCount,
} from "./model.js";
import { CHAT_THEME, type ColorRole } from "./theme.js";

export interface Seg {
  role: ColorRole | null;
  text: string;
}
export type ViewLine = Seg[];

export interface ChatMeta {
  modelId: string;
  authKind: string;
  contextWindow: number;
  repoName: string;
  branch: string | null;
}

export type EmptyStateElement =
  | { kind: "wordmark"; text: string }
  | { kind: "line"; segs: ViewLine };

const g = CHAT_THEME.glyphs;

const ctxLabel = (cw: number): string =>
  cw >= 1_000_000 ? `${cw / 1_000_000}M ctx` : `${Math.round(cw / 1000)}k ctx`;

// UX-30: seven elements, in order; the first entry replaces them.
export const emptyState = (meta: ChatMeta): EmptyStateElement[] => [
  { kind: "wordmark", text: "obligato" },
  { kind: "line", segs: [{ role: "dim", text: "spec-first agent harness" }] },
  {
    kind: "line",
    segs: [
      { role: "fg", text: "model  " },
      { role: "accent", text: meta.modelId },
      {
        role: "dim",
        text: ` ${g.sep} ${ctxLabel(meta.contextWindow)} ${g.sep} ${meta.authKind}`,
      },
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "fg", text: "repo   " },
      { role: "fg", text: meta.repoName },
      ...(meta.branch !== null
        ? [{ role: "dim" as const, text: ` ${g.sep} ${meta.branch}` }]
        : []),
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "dim", text: `${g.info} try  ` },
      { role: "fg", text: '"add a divergence test for PERM-5"' },
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "dim", text: `${g.info} try  ` },
      { role: "fg", text: '"why did CI fail on the last push?"' },
    ],
  },
  {
    kind: "line",
    segs: [
      {
        role: "dim",
        text: `/model ${g.sep} /route ${g.sep} /help ${g.sep} /exit`,
      },
    ],
  },
];

// UX-30 cost formatting: ~ for subscription (PROV-6 yardstick, T2.5),
// unpriced suffix for unknown (PROV-3), both compose.
export const costText = (args: {
  authKind: string;
  costMicroUsd: number;
  costUnknown: boolean;
}): string => {
  const base = `$${(args.costMicroUsd / 1_000_000).toFixed(4)}`;
  const marked = args.authKind === "subscription" ? `~${base}` : base;
  return args.costUnknown ? `${marked} (some steps unpriced)` : marked;
};

// UX-31: transcript as role-tagged lines. The selection accents only while
// transcript-focused (divergence-pinned).
export const transcriptLines = (model: ChatModel): ViewLine[] => {
  const folds = foldableIndices(model.entries);
  const selectedEntry =
    model.focus === "transcript" && folds.length > 0
      ? folds[Math.min(model.selected, folds.length - 1)]
      : undefined;
  return model.entries.flatMap((e, i): ViewLine[] => {
    if (e.kind === "user")
      return [
        [
          { role: "user", text: `${g.user} ` },
          { role: "fg", text: e.text },
        ],
      ];
    if (e.kind === "info")
      return e.text.split("\n").map(
        (line, li): ViewLine =>
          li === 0
            ? [
                { role: "dim", text: `${g.info} ` },
                { role: "fg", text: line },
              ]
            : [{ role: "fg", text: `  ${line}` }],
      );
    if (e.kind === "assistant")
      return e.text === ""
        ? []
        : e.text
            .split("\n")
            .map((line): ViewLine => [{ role: "fg", text: line }]);
    // tool
    const status: Seg = e.ok
      ? { role: "ok", text: g.ok }
      : { role: "err", text: g.err };
    if (!isFoldable(e))
      return [
        [{ role: "tool", text: `  ${status.text} ${e.name}` }],
        ...e.output
          .split("\n")
          .map((line): ViewLine => [{ role: "dim", text: `  ${line}` }]),
      ];
    const n = lineCount(e.output);
    const summaryText = e.expanded
      ? `  ${g.unfold} ${e.name} ${status.text} ${n} lines`
      : `  ${g.fold} ${e.name} ${status.text} ${n} lines (enter expands)`;
    const summary: ViewLine =
      i === selectedEntry
        ? [{ role: "accent", text: summaryText }]
        : [{ role: "tool", text: summaryText }];
    return e.expanded
      ? [
          summary,
          ...e.output
            .split("\n")
            .map((line): ViewLine => [{ role: "dim", text: `  ${line}` }]),
        ]
      : [summary];
  });
};

// UX-30/31: ticker — spinner segment only while busy; state word otherwise.
export const tickerLine = (
  model: ChatModel,
): { left: string; right: string } => {
  const cost = costText({
    authKind: model.meta.authKind,
    costMicroUsd: model.costMicroUsd,
    costUnknown: model.costUnknown,
  });
  const spin = CHAT_THEME.glyphs.spin;
  const state = model.busy
    ? `${spin[model.tickCount % spin.length]} thinking ${g.sep} ${Math.floor(model.tickCount / 10)}s`
    : model.ask !== null
      ? "paused"
      : "ready";
  return { left: `${cost} ${g.sep} ${state}`, right: `/help ${g.sep} esc` };
};

export const headerLine = (
  model: ChatModel,
): { left: string; right: string } => ({
  left: "obligato chat",
  right: `${model.modelId} ${g.sep} ${model.meta.authKind}`,
});
