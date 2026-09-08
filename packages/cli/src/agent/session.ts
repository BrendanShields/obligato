import {
  buildSessionTree,
  compactSession,
  compareBranches,
  currentHead,
  forkSession,
  listEvents,
  promoteSession,
} from "@obligato/agent";
import { DEFAULT_DB_PATH, openDb, sessionView } from "@obligato/kernel";
import {
  SessionTreeNode,
  type UiSessionItem,
  UiSessionView,
} from "@obligato/schemas";
import { z } from "zod";
import { parseArgs } from "../args.js";
import { treeDepth } from "../chat/view.js";
import { kvGrid, table } from "../components/render.js";
import { write } from "../components/sink.js";
import { SYM } from "../components/theme.js";
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

  if (sub === "show") {
    const sid =
      positional[0] ?? fail("usage: obligato session show <session> [--json]");
    // UX-52: the UX-50 kernel view — the same function GET /api/session/<id>
    // serves, one data spine (F-085).
    const view = sessionView(db, sid as string);
    if (named.json === true) emitJson(UiSessionView.parse(view));
    else if (view.session === null)
      write(`no session ${sid} in the store — start one with obligato chat`);
    else {
      const s = view.session;
      write(
        kvGrid([
          ["session", s.id],
          ["repo", s.repo],
          ["status", s.status],
          ["runner", s.runner ?? "unknown"],
          ["model", s.model ?? "unknown"],
          ["auth", s.auth_kind ?? "unknown"],
          ["started", s.started_at],
          ["ended", s.ended_at ?? "—"],
          ["steps", String(s.steps)],
          ["tokens", `${s.tokens} tok`],
          [
            "cost",
            s.cost_micro_usd === null
              ? `n/a (${s.unpriced_steps} unpriced)`
              : usd(s.cost_micro_usd),
          ],
        ]),
      );
      write("");
      write(
        table(
          [
            { header: "#", align: "right" },
            { header: "kind" },
            { header: "at" },
            { header: "detail" },
            { header: "cost", align: "right" },
          ],
          view.items.map(itemRow),
        ),
      );
    }
    if (view.session === null) process.exitCode = 1;
    return;
  }

  fail(
    `unknown session subcommand: ${sub ?? "(none)"} (have: tree, fork, compare, compact, show)`,
  );
};

const usd = (v: number): string => `$${(v / 1_000_000).toFixed(4)}`;

// UX-52: one table row per UX-50 item; outcomes carry symbols (UX-4).
const itemRow = (it: UiSessionItem): string[] => {
  const at = it.at.slice(11, 19);
  const cost =
    it.kind === "step"
      ? it.cost_micro_usd === null
        ? "n/a"
        : usd(it.cost_micro_usd)
      : "";
  const detail = ((): string => {
    switch (it.kind) {
      case "user":
        return it.preview;
      case "step":
        return `${it.model} · ${it.tokens_in + it.tokens_out} tok · ${it.tool_calls} calls${it.preview === "" ? "" : ` · ${it.preview}`}`;
      case "tool":
        return `${it.ok ? SYM.pass : SYM.fail} ${it.name} ${it.detail}`.trimEnd();
      case "permission":
        return `${it.phase} ${it.tool} ${it.detail}`.trimEnd();
      case "compaction":
        return `${it.from_event.slice(0, 8)} … ${it.to_event.slice(0, 8)}`;
      case "model_switch":
        return `${it.from} → ${it.to}`;
      case "escalation":
        return `→ ${it.model}`;
      case "obligation":
        return `${it.status === "pass" ? SYM.pass : SYM.fail} ${it.clause_id} ${it.status}`;
      case "fork":
        return `from ${it.from_event.slice(0, 8)}`;
      case "meta":
        return it.keys.join(", ");
      case "budget":
        return `${it.event} ${it.detail}`;
    }
  })();
  // UX-4: the fixed columns take 35 cells; the detail column is capped so a
  // row never exceeds 80 columns.
  const clipped = detail.length > 44 ? `${detail.slice(0, 44)}…` : detail;
  return [String(it.seq), it.kind, at, clipped, cost];
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
