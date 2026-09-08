import { existsSync } from "node:fs";
import { INBOX_EMPTY_VERB, inboxView, openDb } from "@obligato/kernel";
import { UiInboxView } from "@obligato/schemas";
import { parseArgs } from "../args.js";
import { table } from "../components/render.js";
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
  write(
    table(
      [
        { header: "kind" },
        { header: "item" },
        { header: "age", align: "right" },
        { header: "verb" },
      ],
      view.items.map((i) => [
        i.kind,
        i.summary,
        formatAge(i.age_seconds),
        i.verb,
      ]),
    ),
  );
};
