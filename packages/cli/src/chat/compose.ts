// UX-35: the pure composer — deterministic, total, rule-table-driven. Same
// chain, same decisions (SES-2 extension). Rule 1 is markdown for assistant
// text; rule 2 (UX-47) is the diff widget for a successful edit/write with
// its call; identity falls through to UX-31's transcriptLines (fold semantics
// live in ONE place, F-085).

import type { WidgetTree } from "@obligato/schemas";
import { diffText } from "./diff.js";
import type { ChatEntry } from "./model.js";

export type ComposeDecision =
  | { kind: "widget"; tree: WidgetTree }
  | { kind: "identity" };

interface ComposeRule {
  match: (entry: ChatEntry) => boolean;
  widget: (entry: ChatEntry) => WidgetTree;
}

// Ordered data rule table — never branching scattered through renderers.
const RULES: ComposeRule[] = [
  {
    // Rule 1: non-empty assistant text renders as markdown.
    match: (e) => e.kind === "assistant" && e.text !== "",
    widget: (e) => ({
      schema_version: 1,
      root: {
        type: "markdown",
        content: e.kind === "assistant" ? e.text : "",
      },
    }),
  },
  {
    // Rule 2 (UX-47): a successful edit/write carrying its call is a diff.
    match: (e) => diffText(e) !== null,
    widget: (e) => ({
      schema_version: 1,
      root: { type: "diff", unified: diffText(e) ?? "" },
    }),
  },
];

export const compose = (entry: ChatEntry): ComposeDecision => {
  for (const rule of RULES)
    if (rule.match(entry)) return { kind: "widget", tree: rule.widget(entry) };
  return { kind: "identity" };
};
