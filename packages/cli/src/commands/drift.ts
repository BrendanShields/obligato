import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_DB_PATH,
  openDb,
  promoteInferred,
  promotionQueue,
} from "@kelson/kernel";
import { DriftListResult } from "@kelson/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { table } from "../components/render.js";
import { write } from "../components/sink.js";
import { SYM } from "../components/theme.js";
import { emitJson } from "../output/json.js";

// UX-22 fatigue budget (§5.4): > 10 open items collapse to module counts.
const FATIGUE_BUDGET = 10;

const moduleOf = (artifactId: string): string => {
  const source = artifactId.split("#")[0] as string;
  const dir = dirname(source);
  return dir === "." ? "(root)" : dir;
};

// UX-22: the promote identity the obligation test checks (F-085 pattern).
export const PROMOTE_ENTRY = promoteInferred;

export const driftCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  // repo is a DB key — realpath-resolved (F-124: /tmp vs /private/tmp).
  const repo =
    typeof named.repo === "string" ? named.repo : realpathSync(process.cwd());
  const db = openDb(typeof named.db === "string" ? named.db : DEFAULT_DB_PATH);
  try {
    if (sub === "list") {
      const survival = promotionQueue(
        db,
        repo,
        typeof named["min-sessions"] === "string"
          ? Number(named["min-sessions"])
          : 0,
      );
      const rows = db
        .query(
          `SELECT d.artifact_id, d.direction, d.detected_at,
                  COALESCE(a.authority, 'authored') AS authority
           FROM drift_event d
           LEFT JOIN artifact a ON a.repo = d.repo AND a.logical_id = d.artifact_id
           WHERE d.repo = ? AND d.resolution = 'open'
           ORDER BY d.rowid`,
        )
        .all(repo) as {
        artifact_id: string;
        direction: "code_under_spec" | "spec_over_code" | "upstream_stale";
        detected_at: string;
        authority: "authored" | "inferred" | "confirmed";
      }[];
      const items = rows.map((r) => ({
        ...r,
        module: moduleOf(r.artifact_id),
      }));
      const collapsed = items.length > FATIGUE_BUDGET;
      const byModule = new Map<
        string,
        { blocking: number; informational: number }
      >();
      for (const item of items) {
        const m = byModule.get(item.module) ?? {
          blocking: 0,
          informational: 0,
        };
        // §5.4: inferred = informational; authored/confirmed = blocking
        if (item.authority === "inferred") m.informational++;
        else m.blocking++;
        byModule.set(item.module, m);
      }
      const result = DriftListResult.parse({
        survival,
        collapsed,
        items: collapsed ? [] : items,
        modules: [...byModule.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([module, counts]) => ({ module, ...counts })),
        schema_version: 1,
      });
      if (named.json === true) {
        emitJson(result);
        return;
      }
      // Survival table is exempt from the fatigue budget — always full.
      write(
        result.survival.length === 0
          ? "inferred clauses awaiting promotion: none"
          : table(
              [
                { header: "inferred clause" },
                { header: "survived", align: "right" },
              ],
              result.survival.map((s) => [
                s.logical_id,
                String(s.sessions_survived),
              ]),
            ),
      );
      if (items.length === 0) {
        write("open drift events: none");
        return;
      }
      if (result.collapsed) {
        write(
          `${items.length} open drift items — collapsed to module counts (fatigue budget: ${FATIGUE_BUDGET})`,
        );
        write(
          table(
            [
              { header: "module" },
              { header: "blocking", align: "right" },
              { header: "informational", align: "right" },
            ],
            result.modules.map((m) => [
              m.module,
              String(m.blocking),
              String(m.informational),
            ]),
          ),
        );
      } else {
        write(
          table(
            [
              { header: "module" },
              { header: "artifact" },
              { header: "direction" },
              { header: "authority" },
            ],
            [...result.items]
              .sort(
                (a, b) =>
                  a.module.localeCompare(b.module) ||
                  a.artifact_id.localeCompare(b.artifact_id),
              )
              .map((i) => [
                i.module,
                i.artifact_id,
                i.direction,
                i.authority === "inferred"
                  ? `${SYM.warn} [informational] inferred`
                  : `${SYM.fail} [blocking] ${i.authority}`,
              ]),
          ),
        );
      }
      write("promote surviving clauses: kelson drift promote <logical-id ...>");
      return;
    }

    if (sub === "promote") {
      // All-or-nothing lives in the kernel fn (UX-22/F-150): the CLI passes
      // the selection through, including the empty one.
      let promoted: string[];
      try {
        promoted = promoteInferred(db, repo, positional);
      } catch (e) {
        return fail((e as Error).message);
      }
      write(
        promoted.length === 0
          ? "nothing to promote (empty selection)"
          : `promoted ${promoted.length} clause(s) to confirmed: ${promoted.join(", ")}`,
      );
      return;
    }

    fail(`unknown drift subcommand: ${sub ?? "(none)"} (have: list, promote)`);
  } finally {
    db.close();
  }
};
