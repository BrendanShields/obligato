import { realpathSync } from "node:fs";
import { DEFAULT_DB_PATH, openDb, rebuildIndex } from "@obligato/kernel";
import { IndexRebuildResult } from "@obligato/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { kvGrid, panel } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

// UX-26: the rebuild identity the obligation test checks (F-085 pattern).
export const REBUILD_ENTRY = rebuildIndex;

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
