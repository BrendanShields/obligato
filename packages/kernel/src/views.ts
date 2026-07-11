import type { Database } from "bun:sqlite";
import type {
  EvalReportResult,
  UiBenchView,
  UiEvalView,
  UiLoopView,
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
