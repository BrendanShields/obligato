// UX-47: the diff snippet for a successful edit/write tool result, built
// from the tool call's own input — a pure function shared by the composer
// (widget decision) and the reducer's fold arithmetic (one fold path, F-085).
// No imports from model.ts/compose.ts so neither side forms a cycle.

const WRITE_PREVIEW_LINES = 40;

export const unifiedSnippet = (
  name: string,
  call: Record<string, unknown>,
): string => {
  const path = String(call.path ?? "");
  const head = [`--- ${path}`, `+++ ${path}`];
  if (name === "edit") {
    // ponytail: exact replaced blocks, no LCS alignment — upgrade path is an
    // LCS hunk builder when edits get large enough to need context lines.
    const old = String(call.old ?? "").split("\n");
    const neu = String(call.new ?? "").split("\n");
    return [
      ...head,
      ...old.map((l) => `-${l}`),
      ...neu.map((l) => `+${l}`),
    ].join("\n");
  }
  const lines = String(call.content ?? "").split("\n");
  const shown = lines.slice(0, WRITE_PREVIEW_LINES).map((l) => `+${l}`);
  const rest = lines.length - WRITE_PREVIEW_LINES;
  return [
    ...head,
    ...shown,
    ...(rest > 0 ? [`… ${rest} more lines`] : []),
  ].join("\n");
};

export interface DiffableEntry {
  kind: string;
  name?: string;
  ok?: boolean;
  call?: Record<string, unknown>;
}

// null = not a diff-typed entry (failed, no call, or not edit/write).
export const diffText = (e: DiffableEntry): string | null =>
  e.kind === "tool" &&
  e.ok === true &&
  (e.name === "edit" || e.name === "write") &&
  e.call !== undefined
    ? unifiedSnippet(e.name, e.call)
    : null;

// Role for one unified line at the render edge (view.ts maps to segments).
export type DiffLineRole = "ok" | "err" | "dim";
export const diffLineRole = (line: string): DiffLineRole =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("…")
    ? "dim"
    : line.startsWith("+")
      ? "ok"
      : line.startsWith("-")
        ? "err"
        : "dim";
