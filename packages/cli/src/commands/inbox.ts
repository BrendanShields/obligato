import { existsSync } from "node:fs";
import { INBOX_EMPTY_VERB, inboxView, openDb } from "@obligato/kernel";
import { UiInboxView } from "@obligato/schemas";
import { parseArgs } from "../args.js";
import { kvGrid } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";
import { resolveUiDbPath } from "../ui/server.js";

// UX-42: the kernel view IS the inbox — the launcher home (UX-43) and the
// API route read the same function; this export is the identity anchor.
export const INBOX_VIEW = inboxView;

// UX-42 store resolution: --db, else the UX-13 repo-first resolver.
export const resolveInboxDbPath = (
  named: Record<string, string | true>,
  cwd = process.cwd(),
): string => (typeof named.db === "string" ? named.db : resolveUiDbPath(cwd));

// A store that does not exist yet is an empty inbox — never a created file
// (openDb would migrate one into existence) and never an error.
export const readInbox = (dbPath: string, nowIso: string): UiInboxView => {
  if (!existsSync(dbPath)) return { empty_verb: INBOX_EMPTY_VERB, items: [] };
  const db = openDb(dbPath);
  try {
    return INBOX_VIEW(db, nowIso);
  } finally {
    db.close();
  }
};

export const formatAge = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
};

export const INBOX_COLUMNS = 80;

// UX-4: cells, not characters — the ellipsis takes the last cell.
export const clip = (s: string, width: number): string => {
  if (Bun.stringWidth(s) <= width) return s;
  let out = "";
  for (const ch of s) {
    if (Bun.stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
};

// UX-42 rendering: two lines per item — a kvGrid row (`<kind> <age>` → summary
// clipped to what 80 columns leave after the key column) then the whole verb
// indented two spaces, never truncated (UX-P5: the verb is what gets pasted).
export const inboxLines = (items: UiInboxView["items"]): string[] => {
  const keys = items.map((i) => `${i.kind} ${formatAge(i.age_seconds)}`);
  const keyWidth = Math.max(...keys.map((k) => Bun.stringWidth(k)));
  const summaryWidth = INBOX_COLUMNS - keyWidth - 2;
  const grid = kvGrid(
    items.map((i, n) => [keys[n] as string, clip(i.summary, summaryWidth)]),
  ).split("\n");
  return items.flatMap((i, n) => [grid[n] as string, `  ${i.verb}`]);
};

export const inboxCommand = (argv: string[]): void => {
  const { named } = parseArgs(argv);
  const view = UiInboxView.parse(
    readInbox(resolveInboxDbPath(named), new Date().toISOString()),
  );
  if (named.json === true) {
    emitJson(view);
    return;
  }
  if (view.items.length === 0) {
    write(`inbox empty — ${view.empty_verb}`);
    return;
  }
  write(inboxLines(view.items).join("\n"));
};
