import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "@obligato/kernel";
import { pinnedLockfileHash } from "./session.ts";

const countBy = (db: Database, sql: string): Record<string, number> =>
  Object.fromEntries(
    (db.query(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]),
  );

const summarize = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ") || "none";

// UX §3: /obligato:status — current task, stage, budget state, pinned lockfile.
export const renderStatus = (db: Database, root: string): string => {
  const latest = db
    .query(
      "SELECT id, status, started_at FROM session ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: string; status: string; started_at: string } | null;
  const steps = db
    .query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in + tokens_out), 0) AS io FROM step_event",
    )
    .get() as { n: number; io: number };
  const drift = (
    db
      .query("SELECT COUNT(*) AS n FROM drift_event WHERE resolution = 'open'")
      .get() as { n: number }
  ).n;
  return [
    "obligato · status",
    "  stage     build (stage tracking lands Phase 3)",
    "  budget    — (budgets land Phase 3)",
    `  lockfile  ${pinnedLockfileHash(root)}`,
    latest
      ? `  session   ${latest.id} ${latest.status} (started ${latest.started_at})`
      : "  session   none recorded — hooks inactive?",
    `  sessions  ${summarize(countBy(db, "SELECT status AS k, COUNT(*) AS n FROM session GROUP BY status"))}`,
    `  steps     ${steps.n} events · ${steps.io.toLocaleString("en-US")} tokens in+out`,
    `  tasks     ${summarize(countBy(db, "SELECT state AS k, COUNT(*) AS n FROM task GROUP BY state"))}`,
    `  drift     ${drift} open staleness flag${drift === 1 ? "" : "s"}`,
  ].join("\n");
};

if (import.meta.main) {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = openDb(join(root, ".obligato", "obligato.db"));
  console.log(renderStatus(db, root));
  db.close();
}
