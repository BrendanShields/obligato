import { realpathSync } from "node:fs";
import { DEFAULT_DB_PATH, openDb, rebuildIndex } from "@kelson/kernel";
import { IndexRebuildResult } from "@kelson/schemas";
import { fail } from "../agent/common.js";
import { kvGrid, panel } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

// UX-26: the rebuild identity the obligation test checks (F-085 pattern).
export const REBUILD_ENTRY = rebuildIndex;

interface Flags {
  positional: string[];
  named: Record<string, string | true>;
}

const parseArgs = (argv: string[]): Flags => {
  const positional: string[] = [];
  const named: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[key] = next;
        i++;
      } else named[key] = true;
    } else positional.push(a);
  }
  return { positional, named };
};

export const indexCommand = (argv: string[]): void => {
  if (argv[0] !== "rebuild")
    fail(`unknown index subcommand: ${argv[0] ?? "(none)"} (have: rebuild)`);
  const { named } = parseArgs(argv.slice(1));
  // repo is a DB key — realpath-resolved (F-124).
  const root = realpathSync(
    typeof named.dir === "string" ? named.dir : process.cwd(),
  );
  const repo = typeof named.repo === "string" ? named.repo : root;
  const db = openDb(typeof named.db === "string" ? named.db : DEFAULT_DB_PATH);
  try {
    let summary: ReturnType<typeof rebuildIndex>;
    try {
      summary = rebuildIndex(db, repo, root);
    } catch (e) {
      return fail((e as Error).message);
    }
    const result = IndexRebuildResult.parse({
      ...summary,
      schema_version: 1,
    });
    if (named.json === true) emitJson(result);
    else
      write(
        panel(
          "index rebuild",
          kvGrid([
            ["ingested", String(result.ingested)],
            ["changed", String(result.changed)],
            ["discrepancies", String(result.discrepancies)],
          ]),
        ),
      );
  } finally {
    db.close();
  }
};
