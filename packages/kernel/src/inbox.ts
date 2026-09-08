import type { Database } from "bun:sqlite";
import type { InboxItem, InboxKind, UiInboxView } from "@obligato/schemas";

// UX-42: the attention queue — everything awaiting a human, one item per
// actionable row, exactly one verb each. `nowIso` is an explicit argument
// (no ambient clock inside the view — F-126 fixture determinism).

// Kind priority = the order the operator should act in.
export const INBOX_KIND_ORDER: InboxKind[] = [
  "proposal_review",
  "divergence",
  "drift",
  "budget_pause",
  "auto_revert",
  "quarantined",
  "paused_session",
];

export const INBOX_EMPTY_VERB = "obligato loop propose";

const ageOf = (now: number, at: string | null): number | null => {
  if (at === null) return null;
  const t = Date.parse(at);
  // Clock skew (a row stamped after `now`) clamps to 0, never negative.
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 1000));
};

const short = (id: string): string =>
  id.length > 10 ? `${id.slice(0, 10)}…` : id;

export const inboxView = (db: Database, nowIso: string): UiInboxView => {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now))
    throw new Error(`inboxView: now must be ISO-8601, got ${nowIso}`);
  const items: InboxItem[] = [];

  // proposal_review: the state machine's three human-driven states (§9.2) —
  // `proposed` awaits `loop gate`, `gated` awaits review (then approve or
  // reject), `approved` awaits `loop apply`. Every other state is terminal
  // or machine-advanced.
  const PROPOSAL_VERBS: Record<string, string> = {
    proposed: "gate",
    gated: "review",
    approved: "apply",
  };
  for (const r of db
    .query(
      "SELECT id, state, target_pack, rationale, updated_at FROM proposal WHERE state IN ('proposed', 'gated', 'approved') ORDER BY rowid",
    )
    .all() as {
    id: string;
    state: string;
    target_pack: string;
    rationale: string;
    updated_at: string;
  }[])
    items.push({
      kind: "proposal_review",
      id: r.id,
      summary: `${r.state} proposal for ${r.target_pack}: ${r.rationale.slice(0, 60)}`,
      age_seconds: ageOf(now, r.updated_at),
      verb: `obligato loop ${PROPOSAL_VERBS[r.state] as string} ${r.id}`,
      count: null,
    });

  // divergence: SPEC-5 — an unresolved report blocks build until resolved.
  for (const r of db
    .query(
      "SELECT id, clause_ids, at FROM divergence_report WHERE resolved = 0 ORDER BY rowid",
    )
    .all() as { id: string; clause_ids: string; at: string }[]) {
    const clauses = JSON.parse(r.clause_ids) as string[];
    items.push({
      kind: "divergence",
      id: r.id,
      summary: `unresolved divergence on ${clauses.join(", ") || "(no clause)"}`,
      age_seconds: ageOf(now, r.at),
      verb: `obligato divergence show ${r.id}`,
      count: null,
    });
  }

  // drift: one collapsed row — `drift list` owns the itemization (UX-22).
  const drift = db
    .query(
      "SELECT COUNT(*) AS n, MIN(detected_at) AS oldest FROM drift_event WHERE resolution = 'open'",
    )
    .get() as { n: number; oldest: string | null };
  if (drift.n > 0)
    items.push({
      kind: "drift",
      id: "drift",
      summary: `${drift.n} open drift item${drift.n === 1 ? "" : "s"}`,
      age_seconds: ageOf(now, drift.oldest),
      verb: "obligato drift list",
      count: drift.n,
    });

  // budget_pause: RPOL-6 §3.1 durable suspensions — the last triage event per
  // step is `triage_requested` (paused) or a `block` resolution (blocked).
  // Only native-session budgets (step_id = session id, AGT-11) are listed;
  // other step budgets have no operator surface today (recorded). The verb
  // INSPECTS: no CLI surface calls BudgetMonitor.resolve yet (F-234), and
  // runTurn short-circuits a paused/blocked session, so `chat --continue`
  // would not act — upgraded when the resolve surface lands.
  for (const r of db
    .query(
      `SELECT b.step_id, b.kind, b.payload, b.at FROM budget_event b
        WHERE b.kind IN ('triage_requested', 'triage_resolved')
          AND b.rowid = (SELECT MAX(x.rowid) FROM budget_event x
                          WHERE x.step_id = b.step_id
                            AND x.kind IN ('triage_requested', 'triage_resolved'))
          AND b.step_id IN (SELECT id FROM session)
        ORDER BY b.rowid`,
    )
    .all() as {
    step_id: string;
    kind: string;
    payload: string;
    at: string;
  }[]) {
    const action = (JSON.parse(r.payload) as { action?: string }).action;
    const state =
      r.kind === "triage_requested"
        ? "paused"
        : action === "block"
          ? "blocked"
          : null;
    if (state === null) continue;
    items.push({
      kind: "budget_pause",
      id: r.step_id,
      summary: `budget ${state} on session ${short(r.step_id)}`,
      age_seconds: ageOf(now, r.at),
      verb: `obligato session tree ${r.step_id}`,
      count: null,
    });
  }

  // auto_revert: quarantined proposals whose LATEST entry into `reverted` was
  // the LOOP-3 sweep (actor `auto`, loop_event state_transition payload). A
  // human `loop revert` is not a notice — the human already knows.
  for (const r of db
    .query(
      `SELECT p.id, p.target_pack, p.updated_at FROM proposal p
        WHERE p.state = 'quarantined'
          AND (SELECT json_extract(e.payload, '$.actor') FROM loop_event e
                WHERE e.proposal_id = p.id AND e.kind = 'state_transition'
                  AND json_extract(e.payload, '$.to') = 'reverted'
                ORDER BY e.rowid DESC LIMIT 1) = 'auto'
        ORDER BY p.rowid`,
    )
    .all() as { id: string; target_pack: string; updated_at: string }[])
    items.push({
      kind: "auto_revert",
      id: r.id,
      summary: `${r.target_pack} auto-reverted (LOOP-3) and quarantined`,
      age_seconds: ageOf(now, r.updated_at),
      verb: `obligato loop release ${r.id}`,
      count: null,
    });

  // quarantined: EVP-5 sticky task quarantine; only `eval suite promote`
  // clears it. The suite DIRECTORY is not stored — the verb carries it as a
  // placeholder the launcher home collects (UX-43). No timestamp column.
  for (const r of db
    .query(
      "SELECT id, suite_id, suite_version FROM benchmark_task WHERE quarantined = 1 ORDER BY rowid",
    )
    .all() as { id: string; suite_id: string; suite_version: string }[])
    items.push({
      kind: "quarantined",
      id: r.id,
      summary: `${r.id} quarantined as flaky in ${r.suite_id}@${r.suite_version}`,
      age_seconds: null,
      verb: `obligato eval suite promote ${r.id} --suite <suite-dir>`,
      count: null,
    });

  // paused_session: PERM-2 — on the session's HEAD CHAIN (latest head_moved
  // by rowid, walked up parent_id — the chain SES-2 reconstructs, so a fork
  // rewound past the ask leaves no phantom item, F-236), the latest
  // permission_request has no permission_decision naming it, and the session
  // row is still open. One recursive walk seeded per open session.
  for (const r of db
    .query(
      `WITH RECURSIVE
         head AS (
           SELECT h.session_id, json_extract(h.payload, '$.head_event_id') AS id
             FROM session_event h JOIN session s ON s.id = h.session_id
            WHERE h.kind = 'head_moved' AND s.status = 'incomplete'
              AND h.rowid = (SELECT MAX(x.rowid) FROM session_event x
                              WHERE x.session_id = h.session_id
                                AND x.kind = 'head_moved')),
         chain(session_id, id, parent_id, kind, payload, at, ord) AS (
           SELECT e.session_id, e.id, e.parent_id, e.kind, e.payload, e.at, e.rowid
             FROM session_event e JOIN head ON e.id = head.id
           UNION ALL
           SELECT e.session_id, e.id, e.parent_id, e.kind, e.payload, e.at, e.rowid
             FROM session_event e JOIN chain c ON e.id = c.parent_id)
       SELECT pr.session_id, pr.at, json_extract(pr.payload, '$.tool') AS tool
         FROM chain pr
        WHERE pr.kind = 'permission_request'
          AND pr.ord = (SELECT MAX(z.ord) FROM chain z
                         WHERE z.session_id = pr.session_id
                           AND z.kind = 'permission_request')
          AND NOT EXISTS (SELECT 1 FROM chain pd
                           WHERE pd.session_id = pr.session_id
                             AND pd.kind = 'permission_decision'
                             AND json_extract(pd.payload, '$.request_id') = pr.id)
        ORDER BY pr.ord`,
    )
    .all() as { session_id: string; at: string; tool: string | null }[])
    items.push({
      kind: "paused_session",
      id: r.session_id,
      summary: `session ${short(r.session_id)} awaiting permission for ${r.tool ?? "a tool"}`,
      age_seconds: ageOf(now, r.at),
      verb: `obligato chat --continue ${r.session_id}`,
      count: null,
    });

  // Kind priority, then oldest first; unknown age sorts last within a kind.
  items.sort((a, b) => {
    const k =
      INBOX_KIND_ORDER.indexOf(a.kind) - INBOX_KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    if (a.age_seconds === null && b.age_seconds === null) return 0;
    if (a.age_seconds === null) return 1;
    if (b.age_seconds === null) return -1;
    return b.age_seconds - a.age_seconds;
  });
  return { empty_verb: INBOX_EMPTY_VERB, items };
};
