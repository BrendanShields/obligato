import type { Database } from "bun:sqlite";
import { MetricsReport } from "@obligato/schemas";

// TEL-8: the one computation of the PRD §3 north-star and secondary metrics.
// Every reporting surface calls this (F-085); none re-derives a rate.

export interface MetricsWindow {
  since?: string | undefined;
  until?: string | undefined;
}

// Half-open [since, until) by lexicographic ISO comparison — chronological
// for the store's own millisecond Z timestamps; a bare-date bound compares
// as a prefix (TEL-8 pin).
const windowSql = (
  expr: string,
  w: MetricsWindow,
): { sql: string; params: string[] } => {
  const parts: string[] = [];
  const params: string[] = [];
  if (w.since !== undefined) {
    parts.push(`${expr} >= ?`);
    params.push(w.since);
  }
  if (w.until !== undefined) {
    parts.push(`${expr} < ?`);
    params.push(w.until);
  }
  return { sql: parts.length === 0 ? "1 = 1" : parts.join(" AND "), params };
};

// A 0 denominator is null — 0/0 must never read as a measured 0.
const ratio = (num: number, den: number): number | null =>
  den === 0 ? null : num / den;

const TASK_STATES = [
  "open",
  "in_progress",
  "delivered",
  "accepted",
  "corrected",
  "abandoned",
] as const;

export const computeMetrics = (
  db: Database,
  window: MetricsWindow = {},
): MetricsReport => {
  const taskWin = windowSql(
    "COALESCE(closed_at, delivered_at, opened_at)",
    window,
  );

  const tasks = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<
    (typeof TASK_STATES)[number],
    number
  >;
  for (const row of db
    .query(
      `SELECT state, COUNT(*) AS n FROM task WHERE ${taskWin.sql} GROUP BY state`,
    )
    .all(...taskWin.params) as { state: string; n: number }[])
    if (row.state in tasks)
      tasks[row.state as (typeof TASK_STATES)[number]] = row.n;

  const terminal = tasks.accepted + tasks.corrected + tasks.abandoned;
  const fpar = ratio(tasks.accepted, terminal);

  // TPAC: every step attributed to a window-accepted task, no time filter on
  // the step itself (TEL-8 pin). SUM of an empty set is NULL in SQLite.
  const tpacRow = db
    .query(
      `SELECT COUNT(*) AS steps,
              COALESCE(SUM(cost_micro_usd), 0) AS cost,
              COUNT(*) - COUNT(cost_micro_usd) AS unpriced,
              COALESCE(SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write), 0) AS tokens
       FROM step_event
       WHERE task_id IN (SELECT id FROM task WHERE state = 'accepted' AND ${taskWin.sql})`,
    )
    .get(...taskWin.params) as {
    steps: number;
    cost: number;
    unpriced: number;
    tokens: number;
  };
  const tpacMicroUsd =
    tasks.accepted === 0 || tpacRow.unpriced > 0
      ? null
      : tpacRow.cost / tasks.accepted;
  const tokensPerAccepted = ratio(tpacRow.tokens, tasks.accepted);

  // Both terms restricted to delivered tasks (two-reading pin 2026-09-08).
  const corr = db
    .query(
      `SELECT COUNT(*) AS delivered,
              COALESCE(SUM(CASE WHEN correction_count > 0 THEN 1 ELSE 0 END), 0) AS corrected
       FROM task WHERE delivered_at IS NOT NULL AND ${taskWin.sql}`,
    )
    .get(...taskWin.params) as { delivered: number; corrected: number };
  const correctionRate = ratio(corr.corrected, corr.delivered);

  const driftWin = windowSql("detected_at", window);
  const drift = (
    db
      .query(`SELECT COUNT(*) AS n FROM drift_event WHERE ${driftWin.sql}`)
      .get(...driftWin.params) as { n: number }
  ).n;

  const intWin = windowSql("at", window);
  const interventions = { correction: 0, clarification: 0, approval: 0 };
  for (const row of db
    .query(
      `SELECT class, COUNT(*) AS n FROM intervention_event WHERE ${intWin.sql} GROUP BY class`,
    )
    .all(...intWin.params) as { class: string; n: number }[])
    if (row.class in interventions)
      interventions[row.class as keyof typeof interventions] = row.n;

  const runWin = windowSql("r.started_at", window);
  const gate = { helps: 0, hurts: 0, no_effect: 0, underpowered: 0 };
  for (const row of db
    .query(
      `SELECT v.decision, COUNT(*) AS n FROM verdict v JOIN eval_run r ON r.id = v.run_id
       WHERE ${runWin.sql} GROUP BY v.decision`,
    )
    .all(...runWin.params) as { decision: string; n: number }[])
    if (row.decision in gate) gate[row.decision as keyof typeof gate] = row.n;
  const verdicts = gate.helps + gate.hurts + gate.no_effect + gate.underpowered;

  const regretWin = windowSql("at", window);
  const regret = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM routing_decision WHERE regret = 1 AND ${regretWin.sql}`,
      )
      .get(...regretWin.params) as { n: number }
  ).n;

  const evalSpend = (
    db
      .query(
        `SELECT COALESCE(SUM(t.cost_micro_usd), 0) AS n FROM eval_task_result t
         JOIN eval_run r ON r.id = t.run_id WHERE ${runWin.sql}`,
      )
      .get(...runWin.params) as { n: number }
  ).n;
  const benchSpend = (
    db
      .query(
        `SELECT COALESCE(SUM(t.cost_micro_usd), 0) AS n FROM bench_task_result t
         JOIN bench_run r ON r.id = t.run_id WHERE ${runWin.sql}`,
      )
      .get(...runWin.params) as { n: number }
  ).n;

  const sessWin = windowSql("s.started_at", window);
  const productSpend = (
    db
      .query(
        `SELECT COALESCE(SUM(e.cost_micro_usd), 0) AS n FROM step_event e
         JOIN session s ON s.id = e.session_id WHERE ${sessWin.sql}`,
      )
      .get(...sessWin.params) as { n: number }
  ).n;

  const costByModel = (
    db
      .query(
        `SELECT e.model, COUNT(*) AS steps,
                COALESCE(SUM(e.tokens_in + e.tokens_out + e.tokens_cache_read + e.tokens_cache_write), 0) AS tokens,
                COALESCE(SUM(e.cost_micro_usd), 0) AS cost,
                COUNT(*) - COUNT(e.cost_micro_usd) AS unpriced
         FROM step_event e JOIN session s ON s.id = e.session_id
         WHERE ${sessWin.sql} GROUP BY e.model ORDER BY steps DESC, e.model`,
      )
      .all(...sessWin.params) as {
      model: string;
      steps: number;
      tokens: number;
      cost: number;
      unpriced: number;
    }[]
  ).map((r) => ({
    model: r.model,
    steps: r.steps,
    tokens: r.tokens,
    cost_micro_usd: r.unpriced > 0 ? null : r.cost,
    unpriced_steps: r.unpriced,
  }));

  const sessions = {
    total: 0,
    complete: 0,
    incomplete: 0,
    degraded: 0,
    by_runner: { cc: 0, native: 0, unknown: 0 },
  };
  const plainSessWin = windowSql("started_at", window);
  for (const row of db
    .query(
      `SELECT status, runner, COUNT(*) AS n FROM session WHERE ${plainSessWin.sql} GROUP BY status, runner`,
    )
    .all(...plainSessWin.params) as {
    status: string;
    runner: string | null;
    n: number;
  }[]) {
    sessions.total += row.n;
    if (
      row.status === "complete" ||
      row.status === "incomplete" ||
      row.status === "degraded"
    )
      sessions[row.status] += row.n;
    const runner =
      row.runner === "cc" || row.runner === "native" ? row.runner : "unknown";
    sessions.by_runner[runner] += row.n;
  }

  return MetricsReport.parse({
    window: { since: window.since ?? null, until: window.until ?? null },
    tasks,
    fpar,
    tpac_micro_usd: tpacMicroUsd,
    tpac_unpriced_steps: tpacRow.unpriced,
    tokens_per_accepted: tokensPerAccepted,
    correction_rate: correctionRate,
    spec_drift_incidents: drift,
    interventions,
    gate: { ...gate, pass_rate: ratio(gate.helps, verdicts) },
    routing_regret_events: regret,
    overhead: {
      eval_spend_micro_usd: evalSpend + benchSpend,
      product_spend_micro_usd: productSpend,
      ratio: ratio(evalSpend + benchSpend, productSpend),
    },
    cost_by_model: costByModel,
    sessions,
    schema_version: 1,
  });
};

// TEL-6/ERD §8: the gauge projection of a report — null metrics are absent,
// never 0. Pure, so the exporter and its test share one source of names.
export const metricsGauges = (
  report: MetricsReport,
): { name: string; value: number; kind: "double" | "int" }[] => {
  const out: { name: string; value: number; kind: "double" | "int" }[] = [];
  const gauge = (name: string, value: number | null): void => {
    if (value !== null) out.push({ name, value, kind: "double" });
  };
  const counter = (name: string, value: number): void =>
    void out.push({ name, value, kind: "int" });
  gauge("obligato.fpar", report.fpar);
  gauge("obligato.tpac", report.tpac_micro_usd);
  gauge("obligato.tokens_per_accepted", report.tokens_per_accepted);
  gauge("obligato.correction_rate", report.correction_rate);
  gauge("obligato.overhead_ratio", report.overhead.ratio);
  gauge("obligato.eval.gate.pass_rate", report.gate.pass_rate);
  counter("obligato.routing.regret", report.routing_regret_events);
  counter("obligato.drift.count", report.spec_drift_incidents);
  counter(
    "obligato.interventions.count",
    report.interventions.correction +
      report.interventions.clarification +
      report.interventions.approval,
  );
  counter("obligato.eval.gate.pass", report.gate.helps);
  counter(
    "obligato.eval.gate.reject",
    report.gate.hurts + report.gate.no_effect,
  );
  counter("obligato.eval.gate.underpowered", report.gate.underpowered);
  counter("obligato.tasks.accepted", report.tasks.accepted);
  counter("obligato.sessions.count", report.sessions.total);
  counter("obligato.sessions.degraded", report.sessions.degraded);
  return out;
};
