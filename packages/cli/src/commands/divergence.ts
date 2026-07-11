import type { Database } from "bun:sqlite";
import { DEFAULT_DB_PATH, openDb } from "@obligato/kernel";
import {
  DivergenceListResult,
  type DivergenceOutcome,
  type DivergenceReportRow,
} from "@obligato/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { panel, sideBySideDiff, table } from "../components/render.js";
import { write } from "../components/sink.js";
import { SYM } from "../components/theme.js";
import { emitJson } from "../output/json.js";

// UX-20: unresolved first, then newest (open reports block build — SPEC-5).
const loadReports = (db: Database): DivergenceReportRow[] =>
  (
    db
      .query(
        `SELECT id, spec_hash, clause_ids, entries, resolved, at
         FROM divergence_report ORDER BY resolved ASC, rowid DESC`,
      )
      .all() as {
      id: string;
      spec_hash: string;
      clause_ids: string;
      entries: string;
      resolved: 0 | 1;
      at: string;
    }[]
  ).map((r) => ({
    id: r.id,
    spec_hash: r.spec_hash,
    clause_ids: JSON.parse(r.clause_ids) as string[],
    entries: JSON.parse(r.entries) as DivergenceReportRow["entries"],
    resolved: r.resolved === 1,
    at: r.at,
  }));

const outcomeText = (o: DivergenceOutcome): string =>
  o.tag === "returned"
    ? `returned\n${JSON.stringify(o.value, null, 2)}`
    : `threw ${o.errorName}`;

export const divergenceCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const db = openDb(typeof named.db === "string" ? named.db : DEFAULT_DB_PATH);
  try {
    if (sub === "list") {
      const reports = loadReports(db);
      if (named.json === true) {
        emitJson(DivergenceListResult.parse({ reports, schema_version: 1 }));
        return;
      }
      if (reports.length === 0) {
        write("no divergence reports recorded");
        return;
      }
      write(
        table(
          [
            { header: "id" },
            { header: "status" },
            { header: "clauses" },
            { header: "probes", align: "right" },
            { header: "at" },
          ],
          reports.map((r) => [
            r.id,
            r.resolved ? `${SYM.pass} resolved` : `${SYM.warn} open`,
            r.clause_ids.join(", "),
            String(r.entries.length),
            r.at,
          ]),
        ),
      );
      return;
    }

    if (sub === "show") {
      const id = positional[0] ?? fail("usage: obligato divergence show <id>");
      const report = loadReports(db).find((r) => r.id === id);
      if (!report) return fail(`no divergence report ${id}`);
      if (named.json === true) {
        emitJson(
          DivergenceListResult.parse({
            reports: [report],
            schema_version: 1,
          }),
        );
        return;
      }
      // §5.2: values on the divergent probe input, never code diffs.
      const body = report.entries
        .map((e) =>
          [
            `clause ${e.clause_id} — differs at ${e.differing_path || "(root)"}`,
            `probe input: ${JSON.stringify(e.probe_input)}`,
            sideBySideDiff(
              `A ${outcomeText(e.outcome_a)}`,
              `B ${outcomeText(e.outcome_b)}`,
              76,
            ),
          ].join("\n"),
        )
        .join("\n\n");
      write(
        panel(
          `divergence ${report.id} — ${report.resolved ? "resolved" : "open"} — clauses ${report.clause_ids.join(", ")}`,
          body || "(no entries recorded)",
        ),
      );
      return;
    }

    fail(
      `unknown divergence subcommand: ${sub ?? "(none)"} (have: list, show)`,
    );
  } finally {
    db.close();
  }
};
