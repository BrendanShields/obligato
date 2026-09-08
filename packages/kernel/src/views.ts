import type { Database } from "bun:sqlite";
import type {
  EvalReportResult,
  UiBenchView,
  UiEvalView,
  UiLoopView,
  UiSearchHit,
  UiSearchView,
  UiSessionHeader,
  UiSessionItem,
  UiSessionView,
  UiTelemetryView,
  UiTraceView,
  Verdict,
} from "@obligato/schemas";
import { readChangelog } from "./loop.ts";

// UX §8 view queries — the single data spine for `obligato ui`. Every function
// returns the shape of its Ui*View schema; the server validates (UX-11).
// UX-12: empty stores yield well-formed empty views with their verb.

export const telemetryView = (db: Database): UiTelemetryView => {
  const tiles = db
    .query(
      `SELECT COUNT(DISTINCT session_id) AS sessions_count,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
       FROM step_event`,
    )
    .get() as {
    sessions_count: number;
    tokens_in: number;
    tokens_out: number;
    cost_micro_usd: number;
  };
  const models = db
    .query(
      "SELECT model, COUNT(*) AS steps FROM step_event GROUP BY model ORDER BY steps DESC",
    )
    .all() as { model: string; steps: number }[];
  const series = db
    .query(
      `SELECT substr(s.started_at, 1, 10) AS day,
              SUM(e.tokens_in + e.tokens_out) AS tokens,
              COALESCE(SUM(e.cost_micro_usd), 0) AS cost_micro_usd
       FROM step_event e JOIN session s ON s.id = e.session_id
       GROUP BY day ORDER BY day`,
    )
    .all() as { day: string; tokens: number; cost_micro_usd: number }[];
  const sessions = db
    .query(
      `SELECT s.id, s.repo, s.status, s.started_at, s.ended_at,
              COUNT(e.id) AS steps,
              COALESCE(SUM(e.tokens_in + e.tokens_out), 0) AS tokens,
              COALESCE(SUM(e.cost_micro_usd), 0) AS cost_micro_usd
       FROM session s LEFT JOIN step_event e ON e.session_id = s.id
       GROUP BY s.id ORDER BY s.rowid DESC LIMIT 100`,
    )
    .all() as UiTelemetryView["sessions"];
  return { empty_verb: "obligato init", ...tiles, models, series, sessions };
};

export const evalView = (db: Database): UiEvalView => {
  const rows = db
    .query(
      `SELECT r.id, r.kind, r.suite_id, r.suite_version, r.started_at,
              r.finished_at, v.decision, v.deltas, v.n
       FROM eval_run r LEFT JOIN verdict v ON v.run_id = r.id
       ORDER BY r.rowid DESC LIMIT 200`,
    )
    .all() as (Record<string, string | number | null> & {
    deltas: string | null;
  })[];
  return {
    empty_verb: "obligato eval ablate <pack> --suite <dir>",
    runs: rows.map((r) => {
      const deltas = r.deltas
        ? (JSON.parse(r.deltas) as {
            fpar: UiEvalView["runs"][number]["fpar_delta"];
            cost_pct: UiEvalView["runs"][number]["cost_delta_pct"];
          })
        : null;
      return {
        id: r.id as string,
        kind: r.kind as "ablate" | "compare" | "replay",
        suite_id: r.suite_id as string,
        suite_version: r.suite_version as string,
        started_at: r.started_at as string,
        finished_at: (r.finished_at as string | null) ?? null,
        decision:
          (r.decision as UiEvalView["runs"][number]["decision"]) ?? null,
        fpar_delta: deltas?.fpar ?? null,
        cost_delta_pct: deltas?.cost_pct ?? null,
        n: (r.n as number | null) ?? null,
      };
    }),
  };
};

// UX-23: stored verdicts for `obligato eval report` — a re-render, never a run.
export const evalReport = (
  db: Database,
  opts: { since?: string } = {},
): EvalReportResult["runs"] => {
  const rows = db
    .query(
      `SELECT r.id, r.kind, r.suite_id, r.suite_version, r.finished_at,
              v.decision, v.deltas, v.n, v.alpha
       FROM eval_run r JOIN verdict v ON v.run_id = r.id
       WHERE r.started_at >= ?
       ORDER BY r.rowid DESC LIMIT 200`,
    )
    .all(opts.since ?? "") as {
    id: string;
    kind: "ablate" | "compare" | "replay";
    suite_id: string;
    suite_version: string;
    finished_at: string | null;
    decision: EvalReportResult["runs"][number]["decision"];
    deltas: string;
    n: number;
    alpha: number;
  }[];
  return rows.map((r) => {
    const deltas = JSON.parse(r.deltas) as {
      fpar: EvalReportResult["runs"][number]["fpar_delta"];
      cost_pct: EvalReportResult["runs"][number]["cost_delta_pct"];
    };
    return {
      run_id: r.id,
      kind: r.kind,
      suite_id: r.suite_id,
      suite_version: r.suite_version,
      finished_at: r.finished_at ?? null,
      decision: r.decision,
      fpar_delta: deltas.fpar,
      cost_delta_pct: deltas.cost_pct,
      n: r.n,
      alpha: r.alpha,
    };
  });
};

// UX-25: bench runs for the web eval surface. Task rows re-aggregate
// bench_task_result with runBench's exact semantics: strict majority
// (passes*2 > repeats) and mean cost over repeats (EVP-11 pin).
export const benchView = (db: Database): UiBenchView => {
  const runs = db
    .query(
      `SELECT id, suite_id, suite_version, executor_candidate,
              executor_baseline, verdict, started_at, finished_at
       FROM bench_run ORDER BY rowid DESC LIMIT 50`,
    )
    .all() as {
    id: string;
    suite_id: string;
    suite_version: string;
    executor_candidate: UiBenchView["runs"][number]["candidate"];
    executor_baseline: UiBenchView["runs"][number]["baseline"];
    verdict: string | null;
    started_at: string;
    finished_at: string | null;
  }[];
  return {
    empty_verb: "obligato bench --suite <dir>",
    runs: runs.map((r) => {
      const verdict = r.verdict ? (JSON.parse(r.verdict) as Verdict) : null;
      const agg = db
        .query(
          `SELECT bench_task_id, agent,
                  (SUM(fpar_pass) * 2 > COUNT(*)) AS fpar,
                  AVG(cost_micro_usd) AS cost
           FROM bench_task_result WHERE run_id = ?
           GROUP BY bench_task_id, agent ORDER BY bench_task_id`,
        )
        .all(r.id) as {
        bench_task_id: string;
        agent: "candidate" | "baseline";
        fpar: 0 | 1;
        cost: number;
      }[];
      const byTask = new Map<
        string,
        Partial<Record<"candidate" | "baseline", { fpar: 0 | 1; cost: number }>>
      >();
      for (const a of agg) {
        const t = byTask.get(a.bench_task_id) ?? {};
        t[a.agent] = { fpar: a.fpar, cost: a.cost };
        byTask.set(a.bench_task_id, t);
      }
      return {
        id: r.id,
        suite_id: r.suite_id,
        suite_version: r.suite_version,
        candidate: r.executor_candidate,
        baseline: r.executor_baseline,
        started_at: r.started_at,
        finished_at: r.finished_at ?? null,
        decision: verdict?.decision ?? null,
        fpar_delta: verdict?.fpar_delta ?? null,
        cost_delta_pct: verdict?.cost_delta_pct ?? null,
        n: verdict?.n ?? null,
        rows: [...byTask.entries()].map(([task_id, t]) => ({
          task_id,
          candidate_fpar: t.candidate?.fpar ?? 0,
          baseline_fpar: t.baseline?.fpar ?? 0,
          candidate_cost_micro_usd: t.candidate?.cost ?? 0,
          baseline_cost_micro_usd: t.baseline?.cost ?? 0,
        })),
      };
    }),
  };
};

export const loopView = (db: Database, changelogPath: string): UiLoopView => {
  const proposals = db
    .query(
      `SELECT id, target_pack, state, created_by, rationale, created_at, updated_at
       FROM proposal ORDER BY rowid`,
    )
    .all() as UiLoopView["proposals"];
  let changelog: UiLoopView["changelog"] = [];
  try {
    changelog = readChangelog(changelogPath);
  } catch {
    // missing changelog is the empty state, not an error (UX-12)
  }
  return { empty_verb: "obligato loop propose", proposals, changelog };
};

export const traceView = (db: Database): UiTraceView => {
  const nodes = db
    .query(
      `SELECT a.logical_id, a.type, a.authority, a.tier, a.content_hash,
              EXISTS(
                SELECT 1 FROM drift_event d
                WHERE d.artifact_id = a.logical_id AND d.resolution = 'open'
              ) AS drift_open
       FROM artifact a ORDER BY a.rowid`,
    )
    .all() as (Omit<UiTraceView["nodes"][number], "drift_open"> & {
    drift_open: 0 | 1;
  })[];
  const edges = db
    .query("SELECT upstream_id, downstream_id FROM trace_link ORDER BY rowid")
    .all() as UiTraceView["edges"];
  return {
    // UX-26: the artifact index regenerates from the files of record
    empty_verb: "obligato index rebuild",
    nodes: nodes.map((n) => ({ ...n, drift_open: n.drift_open === 1 })),
    edges,
  };
};

// UX-50: the per-session timeline — one function behind `GET /api/session/<id>`
// and `obligato session show` (F-085). Items are the raw rowid stream across
// every branch (no chain reconstruction); the session's budget events follow
// in their own rowid order — never timestamp-interleaved (F-060/F-067).
const firstLine = (v: unknown): string =>
  String(v ?? "")
    .split("\n")[0]
    ?.slice(0, 80) ?? "";

interface EventRow {
  id: string;
  kind: string;
  payload: string;
  at: string;
  parent_id: string | null;
}

const sessionItem = (row: EventRow, seq: number): UiSessionItem => {
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  const base = { seq, id: row.id, at: row.at };
  const meta = (): UiSessionItem => ({
    ...base,
    kind: "meta",
    keys: Object.keys(p),
  });
  switch (row.kind) {
    case "user_message":
      return { ...base, kind: "user", preview: firstLine(p.text) };
    case "assistant_message": {
      const u = (p.usage ?? {}) as Record<string, unknown>;
      const n = (k: string): number => Number(u[k] ?? 0);
      return {
        ...base,
        kind: "step",
        model:
          typeof p.model === "string" && p.model !== "" ? p.model : "unknown",
        tokens_in: n("tokens_in"),
        tokens_out: n("tokens_out"),
        tokens_cache_read: n("tokens_cache_read"),
        tokens_cache_write: n("tokens_cache_write"),
        cost_micro_usd:
          typeof p.cost_micro_usd === "number" ? p.cost_micro_usd : null,
        tool_calls: Array.isArray(p.tool_calls) ? p.tool_calls.length : 0,
        preview: firstLine(p.text),
      };
    }
    case "tool_result":
      return {
        ...base,
        kind: "tool",
        name: typeof p.name === "string" && p.name !== "" ? p.name : "unknown",
        ok: p.is_error !== true,
        detail: firstLine(p.output),
      };
    case "permission_request":
      return {
        ...base,
        kind: "permission",
        phase: "request",
        tool: String(p.tool ?? ""),
        detail: firstLine(p.arg),
      };
    case "permission_decision":
      return {
        ...base,
        kind: "permission",
        phase: "decision",
        tool: String(p.tool ?? ""),
        detail: String(p.decision ?? ""),
      };
    // A `compaction`-kind row (the enum admits it; SES-8 writes compaction as
    // a session_meta payload) maps to the same variant — totality.
    case "compaction":
      return {
        ...base,
        kind: "compaction",
        from_event: String(p.from_event ?? ""),
        to_event: String(p.to_event ?? ""),
      };
    case "session_meta": {
      const c = p.compaction as Record<string, unknown> | undefined;
      if (c)
        return {
          ...base,
          kind: "compaction",
          from_event: String(c.from_event ?? ""),
          to_event: String(c.to_event ?? ""),
        };
      const sw = p.model_switch as Record<string, unknown> | undefined;
      if (sw)
        return {
          ...base,
          kind: "model_switch",
          from: String(sw.from ?? ""),
          to: String(sw.to ?? ""),
        };
      const esc = p.routing_escalation as Record<string, unknown> | undefined;
      if (esc)
        return {
          ...base,
          kind: "escalation",
          model: String(esc.modelId ?? ""),
        };
      const ob = p.obligation_check as Record<string, unknown> | undefined;
      if (ob)
        return {
          ...base,
          kind: "obligation",
          clause_id: String(ob.clause_id ?? ""),
          status: ob.status === "pass" ? "pass" : "fail",
        };
      if (p.forked_from !== undefined)
        return { ...base, kind: "fork", from_event: String(p.forked_from) };
      return meta();
    }
    default:
      return meta();
  }
};

const budgetDetail = (kind: string, p: Record<string, unknown>): string => {
  if (kind === "overrun") {
    const a = (p.attribution ?? {}) as Record<string, unknown>;
    return `${String(p.threshold)}× budget (${String(a.used_tokens ?? "?")}/${String(a.budget_tokens ?? "?")} tok)`;
  }
  if (kind === "triage_requested")
    return `awaiting triage: ${(Array.isArray(p.options) ? p.options : []).join("|")}`;
  const reason = typeof p.reason === "string" ? ` (${p.reason})` : "";
  return `${String(p.action ?? "")} by ${String(p.actor ?? "")}${reason}`;
};

export const sessionView = (db: Database, sessionId: string): UiSessionView => {
  const empty_verb = "obligato chat";
  const row = db
    .query(
      "SELECT id, repo, status, runner, started_at, ended_at FROM session WHERE id = ?",
    )
    .get(sessionId) as {
    id: string;
    repo: string;
    status: UiSessionHeader["status"];
    runner: UiSessionHeader["runner"];
    started_at: string;
    ended_at: string | null;
  } | null;
  if (!row) return { empty_verb, session: null, items: [] };
  const root = db
    .query(
      "SELECT payload FROM session_event WHERE session_id = ? AND kind = 'session_meta' AND parent_id IS NULL ORDER BY rowid LIMIT 1",
    )
    .get(sessionId) as { payload: string } | null;
  const rootPayload = root
    ? (JSON.parse(root.payload) as Record<string, unknown>)
    : {};
  const agg = db
    .query(
      `SELECT COUNT(*) AS steps,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_micro_usd), 0) AS cost,
              COUNT(*) - COUNT(cost_micro_usd) AS unpriced
       FROM step_event WHERE session_id = ?`,
    )
    .get(sessionId) as {
    steps: number;
    tokens: number;
    cost: number;
    unpriced: number;
  };
  const events = db
    .query(
      "SELECT id, kind, payload, at, parent_id FROM session_event WHERE session_id = ? AND kind != 'head_moved' ORDER BY rowid",
    )
    .all(sessionId) as EventRow[];
  const items: UiSessionItem[] = [];
  let rootSeen = false;
  for (const e of events) {
    // The root session_meta is the header, not an item (UX-50).
    if (!rootSeen && e.kind === "session_meta" && e.parent_id === null) {
      rootSeen = true;
      continue;
    }
    items.push(sessionItem(e, items.length + 1));
  }
  const budget = db
    .query(
      "SELECT id, kind, payload, at FROM budget_event WHERE step_id = ? ORDER BY rowid",
    )
    .all(sessionId) as {
    id: string;
    kind: string;
    payload: string;
    at: string;
  }[];
  for (const b of budget)
    items.push({
      seq: items.length + 1,
      id: b.id,
      at: b.at,
      kind: "budget",
      event: b.kind as "overrun" | "triage_requested" | "triage_resolved",
      detail: budgetDetail(
        b.kind,
        JSON.parse(b.payload) as Record<string, unknown>,
      ),
    });
  return {
    empty_verb,
    session: {
      id: row.id,
      repo: row.repo,
      status: row.status,
      runner: row.runner,
      model: typeof rootPayload.model === "string" ? rootPayload.model : null,
      auth_kind:
        typeof rootPayload.auth_kind === "string"
          ? rootPayload.auth_kind
          : null,
      started_at: row.started_at,
      ended_at: row.ended_at,
      steps: agg.steps,
      tokens: agg.tokens,
      // PROV-3: an unpriced step makes the total unknown, never a partial sum.
      cost_micro_usd: agg.unpriced > 0 ? null : agg.cost,
      unpriced_steps: agg.unpriced,
    },
    items,
  };
};

// UX-51: palette search — substring match per entity kind, every hit naming
// the CLI verb that acts on it (UX-5). LIKE wildcards in the query are
// escaped so a query matches literally.
const SEARCH_CAP = 50;

export const searchView = (db: Database, q: string): UiSearchView => {
  const empty_verb = "obligato chat";
  const query = q.trim();
  if (query === "") return { empty_verb, query, hits: [] };
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const hits: UiSearchHit[] = [];
  const collect = (
    sql: string,
    kind: UiSearchHit["kind"],
    command: (id: string) => string,
  ): void => {
    const rows = db.query(sql).all({ $q: like }) as {
      id: string;
      label: string;
    }[];
    for (const r of rows) {
      if (hits.length >= SEARCH_CAP) return;
      hits.push({ kind, id: r.id, label: r.label, command: command(r.id) });
    }
  };
  const lim = `LIMIT ${SEARCH_CAP}`;
  collect(
    `SELECT id, repo AS label FROM session WHERE id LIKE $q ESCAPE '\\' OR repo LIKE $q ESCAPE '\\' ORDER BY rowid ${lim}`,
    "session",
    (id) => `obligato session show ${id}`,
  );
  collect(
    `SELECT id, suite_id AS label FROM eval_run WHERE id LIKE $q ESCAPE '\\' OR suite_id LIKE $q ESCAPE '\\' ORDER BY rowid ${lim}`,
    "eval_run",
    () => "obligato eval report",
  );
  collect(
    `SELECT id, rationale AS label FROM proposal WHERE id LIKE $q ESCAPE '\\' OR rationale LIKE $q ESCAPE '\\' ORDER BY rowid ${lim}`,
    "proposal",
    (id) => `obligato loop review ${id}`,
  );
  collect(
    `SELECT id, clause_ids AS label FROM divergence_report WHERE id LIKE $q ESCAPE '\\' OR clause_ids LIKE $q ESCAPE '\\' ORDER BY rowid ${lim}`,
    "divergence",
    (id) => `obligato divergence show ${id}`,
  );
  collect(
    `SELECT logical_id AS id, type || ' ' || tier AS label FROM artifact WHERE logical_id LIKE $q ESCAPE '\\' ORDER BY rowid ${lim}`,
    "clause",
    () => "obligato drift list",
  );
  return { empty_verb, query, hits };
};
