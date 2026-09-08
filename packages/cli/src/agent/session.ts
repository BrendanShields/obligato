import {
  buildSessionTree,
  compactSession,
  compareBranches,
  currentHead,
  forkSession,
  listEvents,
  promoteSession,
} from "@obligato/agent";
import { DEFAULT_DB_PATH, openDb } from "@obligato/kernel";
import { SessionListResult, SessionTreeNode } from "@obligato/schemas";
import { z } from "zod";
import { parseArgs } from "../args.js";
import { treeDepth } from "../chat/view.js";
import { table } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";
import { fail } from "./common.js";

const openStore = (dbPath?: string) =>
  openDb(typeof dbPath === "string" ? dbPath : DEFAULT_DB_PATH);

// SES-6/7/8: `obligato session fork|compare|compact`.
export const sessionCommand = (argv: string[]): void => {
  const [sub, ...rest] = argv;
  const { positional, named } = parseArgs(rest);
  const db = openStore(named.db as string | undefined);

  if (sub === "tree") {
    const sid =
      positional[0] ?? fail("usage: obligato session tree <session> [--json]");
    // UX-34: same builder as the chat rail pane (F-085 — one function).
    const events = listEvents(db, sid as string);
    const nodes = buildSessionTree(events, currentHead(events));
    if (named.json === true) {
      emitJson(z.array(SessionTreeNode).parse(nodes));
      return;
    }
    for (const n of nodes)
      write(`${"  ".repeat(treeDepth(nodes, n))}${n.label}`);
    return;
  }

  if (sub === "list") {
    // UX-48: native sessions newest first (rowid desc); cost null when any
    // step is unpriced (PROV-3) — SUM over an empty group is NULL → 0 steps.
    const limit = typeof named.limit === "string" ? Number(named.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1)
      fail("--limit must be a positive integer");
    const rows = db
      .query(
        `SELECT s.id, s.status, s.started_at, s.ended_at,
                COUNT(e.id) AS steps,
                SUM(e.cost_micro_usd) AS cost,
                COUNT(e.id) - COUNT(e.cost_micro_usd) AS unknowns
         FROM session s LEFT JOIN step_event e ON e.session_id = s.id
         WHERE s.runner = 'native'
         GROUP BY s.id ORDER BY s.rowid DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      steps: number;
      cost: number | null;
      unknowns: number;
    }[];
    const result = SessionListResult.parse({
      sessions: rows.map((r) => ({
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        ended_at: r.ended_at,
        steps: r.steps,
        cost_micro_usd: r.unknowns > 0 ? null : (r.cost ?? 0),
      })),
      schema_version: 1,
    });
    if (named.json === true) {
      emitJson(result);
      return;
    }
    if (result.sessions.length === 0) {
      write("no native sessions — obligato chat");
      return;
    }
    write(
      table(
        [
          { header: "session" },
          { header: "status" },
          { header: "started" },
          { header: "steps", align: "right" },
          { header: "cost", align: "right" },
        ],
        result.sessions.map((s) => [
          s.id,
          s.status,
          s.started_at,
          String(s.steps),
          s.cost_micro_usd === null
            ? "n/a"
            : `$${(s.cost_micro_usd / 1_000_000).toFixed(4)}`,
        ]),
      ),
    );
    return;
  }

  if (sub === "fork") {
    const sid =
      positional[0] ??
      fail("usage: obligato session fork <session> [event-id]");
    const { forkHead, originalHead } = forkSession(
      db,
      sid as string,
      positional[1],
    );
    write(`forked ${sid}`);
    write(`  fork head:     ${forkHead}`);
    write(`  original head: ${originalHead}`);
    return;
  }

  if (sub === "compare") {
    const sid = positional[0];
    const headA = positional[1];
    const headB = positional[2];
    if (!sid || !headA || !headB)
      fail("usage: obligato session compare <session> <headA> <headB>");
    const cmp = compareBranches(
      db,
      sid as string,
      headA as string,
      headB as string,
    );
    write(`common ancestor: ${cmp.common_ancestor ?? "(none)"}`);
    write(`shared prefix:   ${cmp.shared_prefix} events`);
    write(
      `A: ${cmp.a.cost_micro_usd} µUSD, ${cmp.a.event_count} events, ${cmp.a.lifecycle} — "${cmp.a.last_text.slice(0, 60)}"`,
    );
    write(
      `B: ${cmp.b.cost_micro_usd} µUSD, ${cmp.b.event_count} events, ${cmp.b.lifecycle} — "${cmp.b.last_text.slice(0, 60)}"`,
    );
    return;
  }

  if (sub === "compact") {
    const sid =
      positional[0] ?? fail("usage: obligato session compact <session>");
    // A single-line naive summarizer; the loop uses a cheap routed model.
    const range = compactSession(
      db,
      sid as string,
      (chain) =>
        `Summary of ${chain.length} prior events (compacted ${new Date().toISOString()}).`,
    );
    write(`compacted ${sid}: [${range.from_event} … ${range.to_event}]`);
    return;
  }

  fail(
    `unknown session subcommand: ${sub ?? "(none)"} (have: tree, list, fork, compare, compact)`,
  );
};

// EVP-10: `obligato promote <session> --suite <staging-dir>`.
export const promoteCommand = (argv: string[]): void => {
  const { positional, named } = parseArgs(argv);
  const sid =
    positional[0] ??
    fail("usage: obligato promote <session> --suite <staging-dir>");
  const suite =
    (named.suite as string) ??
    fail("usage: obligato promote <session> --suite <staging-dir>");
  const db = openStore(named.db as string | undefined);
  const task = promoteSession(db, sid as string, suite);
  write(`promoted ${sid} → ${task.id}`);
  write(`  statement: ${task.statement.slice(0, 70)}`);
  write(`  snapshot:  ${task.snapshot}`);
  write(`  budget:    ${task.budget_ceiling_musd} µUSD`);
  write(`  checks:    ${task.checks.map((c) => c.kind).join(", ")}`);
  write(
    `  → replay with: obligato eval ablate --suite ${suite} --executor api`,
  );
};
