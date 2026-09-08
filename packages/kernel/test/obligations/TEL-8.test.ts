import { describe, expect, it } from "bun:test";
import { MetricsReport } from "@obligato/schemas";
import { computeMetrics } from "../../src/metrics.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

// Every expected value below is hand-derived from the seeded rows — the
// function under test never computes an expectation (verification
// independence, CLAUDE.md rule 7).

type Db = ReturnType<typeof openDb>;
const T = (h: number, m = 0): string =>
  `2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const task = (
  db: Db,
  state: string,
  args: { delivered?: string; closed?: string; corrections?: number },
): string => {
  const id = ulid();
  db.query(
    `INSERT INTO task (id, repo, spec_clause_refs, state, acceptance_signal, correction_count, opened_at, delivered_at, closed_at)
     VALUES (?, 'r', '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    state,
    state === "accepted" ? "approval" : null,
    args.corrections ?? 0,
    T(1),
    args.delivered ?? null,
    args.closed ?? null,
  );
  return id;
};

const session = (
  db: Db,
  status: string,
  runner: string | null,
  startedAt: string,
): string => {
  const id = ulid();
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, runner, trace_id, started_at, ended_at)
     VALUES (?, 'r', ?, '0.1.0', 1, ?, ?, NULL, ?, NULL)`,
  ).run(id, `sha256:${"a".repeat(64)}`, status, runner, startedAt);
  return id;
};

const step = (
  db: Db,
  taskId: string,
  sessionId: string,
  model: string,
  cost: number | null,
  tokens: [number, number, number, number],
): void => {
  db.query(
    `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
     VALUES (?, ?, ?, 'build', ?, 'medium', 'native', ?, ?, ?, ?, '{}', ?, 1000, 'none', NULL, 1)`,
  ).run(ulid(), taskId, sessionId, model, ...tokens, cost);
};

const evalRun = (db: Db, startedAt: string, costs: number[]): string => {
  const id = ulid();
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
     VALUES (?, 'ablate', 's', '1', '{}', NULL, 0, 'api', '{}', '{}', 'h', ?, NULL)`,
  ).run(id, startedAt);
  for (const c of costs)
    db.query(
      `INSERT INTO eval_task_result (id, run_id, bench_task_id, side, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
       VALUES (?, ?, 't', 'A', 0, 1, ?, '[]', NULL, 1)`,
    ).run(ulid(), id, c);
  return id;
};

const verdict = (db: Db, runId: string, decision: string): void => {
  db.query(
    "INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, ?, '{}', 3, 0.05)",
  ).run(ulid(), runId, decision);
};

const benchRun = (db: Db, startedAt: string, costs: number[]): void => {
  const id = ulid();
  db.query(
    `INSERT INTO bench_run (id, suite_id, suite_version, executor_candidate, executor_baseline, config, seed, repeats, model_versions, sandbox_profile, manifest_hash, verdict, started_at, finished_at)
     VALUES (?, 's', '1', 'api', 'claude', '{}', 0, 1, '{}', '{}', 'h', NULL, ?, NULL)`,
  ).run(id, startedAt);
  for (const c of costs)
    db.query(
      `INSERT INTO bench_task_result (id, run_id, bench_task_id, agent, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
       VALUES (?, ?, 't', 'candidate', 0, 1, ?, '[]', NULL, 1)`,
    ).run(ulid(), id, c);
};

const drift = (db: Db, at: string): void => {
  db.query(
    "INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, schema_version) VALUES (?, 'r', 'a', 'code_under_spec', ?, 1)",
  ).run(ulid(), at);
};

const intervention = (db: Db, cls: string, at: string): void => {
  db.query(
    "INSERT INTO intervention_event (id, task_id, session_id, class, artifact_hash, at, schema_version) VALUES (?, ?, ?, ?, NULL, ?, 1)",
  ).run(ulid(), ulid(), ulid(), cls, at);
};

const routing = (db: Db, regret: 0 | 1, at: string): void => {
  db.query(
    `INSERT INTO routing_decision (id, task_id, step_id, attempt, kind, feature_vector, rule_index, matched_by, target, effort, loadout, budget_tokens, escalation, policy_hash, regret, at, schema_version)
     VALUES (?, ?, ?, 0, 'initial', '{}', 0, 'rule', 'm', 'low', '[]', 100, '[]', 'p', ?, ?, 1)`,
  ).run(ulid(), ulid(), ulid(), regret, at);
};

// Seeds the hand-known fixture; returns the ids the assertions need.
const seed = (db: Db) => {
  // Tasks: 3 accepted, 1 corrected (1 correction), 2 abandoned — one
  // delivered first (in the correction denominator), one never delivered —
  // and 1 still open. Delivered = 5.
  const a1 = task(db, "accepted", { delivered: T(2), closed: T(3) });
  const a2 = task(db, "accepted", { delivered: T(2), closed: T(4) });
  const a3 = task(db, "accepted", { delivered: T(2), closed: T(5) });
  const c1 = task(db, "corrected", {
    delivered: T(2),
    closed: T(6),
    corrections: 1,
  });
  task(db, "abandoned", { delivered: T(2), closed: T(6, 30) });
  task(db, "abandoned", { closed: T(7) });
  task(db, "open", {});
  // Sessions: S1 complete/native, S2 degraded/cc, S3 incomplete/null runner.
  const s1 = session(db, "complete", "native", T(2));
  const s2 = session(db, "degraded", "cc", T(2, 30));
  const s3 = session(db, "incomplete", null, T(2, 45));
  // Steps on accepted tasks (TPAC inputs): costs 100, 200, 300, 400;
  // tokens 15, 15, 20, 40. Corrected task step: cost 50 (product spend only).
  step(db, a1, s1, "m1", 100, [10, 5, 0, 0]);
  step(db, a1, s1, "m1", 200, [10, 5, 0, 0]);
  step(db, a2, s2, "m1", 300, [10, 5, 5, 0]);
  step(db, a3, s3, "m2", 400, [20, 10, 5, 5]);
  step(db, c1, s1, "m2", 50, [1, 1, 0, 0]);
  return { a3, s1, s2, s3 };
};

describe("TEL-8: computeMetrics — north-star + secondary metrics over a hand-seeded store", () => {
  it("FPAR, TPAC, tokens per accepted, correction rate, counts, sessions, cost by model", () => {
    const db = openDb(":memory:");
    seed(db);
    drift(db, T(3));
    drift(db, T(4));
    intervention(db, "correction", T(3));
    intervention(db, "clarification", T(3));
    intervention(db, "clarification", T(4));
    const r1 = evalRun(db, T(3), [50, 70]);
    verdict(db, r1, "helps");
    const r2 = evalRun(db, T(4), []);
    verdict(db, r2, "hurts");
    benchRun(db, T(5), [30]);
    routing(db, 1, T(3));
    routing(db, 1, T(4));
    routing(db, 0, T(5));

    const m = computeMetrics(db, {});
    expect(MetricsReport.safeParse(m).success).toBe(true);
    expect(m.tasks).toEqual({
      open: 1,
      in_progress: 0,
      delivered: 0,
      accepted: 3,
      corrected: 1,
      abandoned: 2,
    });
    // revert-check: return accepted/total instead of accepted/terminal → 3/7
    // fails the 3/6 line below.
    expect(m.fpar).toBe(3 / 6);
    // (100 + 200 + 300 + 400) / 3 — the corrected task's 50 is excluded.
    expect(m.tpac_micro_usd).toBe(1000 / 3);
    expect(m.tpac_steps).toBe(4);
    expect(m.tpac_unpriced_steps).toBe(0);
    // (15 + 15 + 20 + 40) / 3
    expect(m.tokens_per_accepted).toBe(90 / 3);
    // 1 corrected of 5 delivered: the delivered-then-abandoned task counts,
    // the never-delivered one does not.
    // revert-check: derive delivered from state (delivered + accepted +
    // corrected) → 4, and the toEqual below fails on `delivered`.
    expect(m.correction).toEqual({ corrected: 1, delivered: 5, rate: 1 / 5 });
    expect(m.spec_drift_incidents).toBe(2);
    expect(m.interventions).toEqual({
      correction: 1,
      clarification: 2,
      approval: 0,
    });
    expect(m.gate).toEqual({
      helps: 1,
      hurts: 1,
      no_effect: 0,
      underpowered: 0,
      pass_rate: 1 / 2,
    });
    expect(m.routing_regret_events).toBe(2);
    // eval 50 + 70 + bench 30 = 150; product = 100+200+300+400+50 = 1050.
    expect(m.overhead).toEqual({
      eval_spend_micro_usd: 150,
      product_spend_micro_usd: 1050,
      unpriced_steps: 0,
      ratio: 150 / 1050,
    });
    expect(m.cost_by_model).toEqual([
      {
        model: "m1",
        steps: 3,
        tokens: 50,
        cost_micro_usd: 600,
        unpriced_steps: 0,
      },
      {
        model: "m2",
        steps: 2,
        tokens: 42,
        cost_micro_usd: 450,
        unpriced_steps: 0,
      },
    ]);
    expect(m.sessions).toEqual({
      total: 3,
      complete: 1,
      incomplete: 1,
      degraded: 1,
      by_runner: { cc: 1, native: 1, unknown: 1 },
    });
    db.close();
  });

  it("a null-cost step on an accepted task nulls TPAC (never coerced to 0) while tokens still compute; cost_by_model nulls that model", () => {
    const db = openDb(":memory:");
    const { a3, s3 } = seed(db);
    step(db, a3, s3, "m2", null, [4, 4, 1, 1]);
    const m = computeMetrics(db, {});
    // revert-check: COALESCE the null cost to 0 in the TPAC query → 1000/3
    // is reported and the toBeNull below fails.
    expect(m.tpac_micro_usd).toBeNull();
    expect(m.tpac_steps).toBe(5);
    expect(m.tpac_unpriced_steps).toBe(1);
    expect(m.tokens_per_accepted).toBe(100 / 3);
    const m2 = m.cost_by_model.find((r) => r.model === "m2");
    expect(m2).toEqual({
      model: "m2",
      steps: 3,
      tokens: 52,
      cost_micro_usd: null,
      unpriced_steps: 1,
    });
    // The unpriced step's session is in window: the priced product sum
    // still reports, the ratio does not.
    // revert-check: compute the ratio over the priced sum regardless →
    // 0 / 1050 = 0 is reported and toBeNull fails.
    expect(m.overhead).toEqual({
      eval_spend_micro_usd: 0,
      product_spend_micro_usd: 1050,
      unpriced_steps: 1,
      ratio: null,
    });
    db.close();
  });

  it("an accepted task with no contributing steps is unmeasured: both means null, tpac_steps 0", () => {
    const db = openDb(":memory:");
    task(db, "accepted", { delivered: T(2), closed: T(3) });
    const m = computeMetrics(db, {});
    expect(m.tasks.accepted).toBe(1);
    expect(m.tpac_steps).toBe(0);
    // revert-check: divide the empty sums by accepted → 0 / 1 = 0 reads as a
    // free accepted change and both toBeNull lines fail.
    expect(m.tpac_micro_usd).toBeNull();
    expect(m.tokens_per_accepted).toBeNull();
    db.close();
  });

  it("an empty store yields null for every rate and 0 for every count", () => {
    const db = openDb(":memory:");
    const m = computeMetrics(db, {});
    // revert-check: return 0 on a 0 denominator in `ratio` → fpar reads 0
    // and the toBeNull fails.
    expect(m.fpar).toBeNull();
    expect(m.tpac_micro_usd).toBeNull();
    expect(m.tokens_per_accepted).toBeNull();
    expect(m.tpac_steps).toBe(0);
    expect(m.correction).toEqual({ corrected: 0, delivered: 0, rate: null });
    expect(m.gate.pass_rate).toBeNull();
    expect(m.overhead.ratio).toBeNull();
    expect(m.tasks.accepted).toBe(0);
    expect(m.spec_drift_incidents).toBe(0);
    expect(m.routing_regret_events).toBe(0);
    expect(m.sessions.total).toBe(0);
    expect(m.cost_by_model).toEqual([]);
    db.close();
  });

  it("the window is half-open [since, until): until equal to a task's closed_at excludes exactly that task; a bare-date bound compares as a prefix", () => {
    const db = openDb(":memory:");
    seed(db);
    // A delivered-state task (no closed_at) is windowed by delivered_at —
    // the COALESCE middle term; the open task by opened_at (T(1)).
    task(db, "delivered", { delivered: T(8) });
    // The never-delivered abandoned task closed at exactly T(7) = until →
    // excluded; the delivered-then-abandoned one (T(6,30)) and c1 (T(6))
    // stay. Terminal in window: 3 accepted + 1 corrected + 1 abandoned.
    const m = computeMetrics(db, { since: T(1), until: T(7) });
    // revert-check: use `<=` for until → abandoned reads 2 and fpar 3/6
    // fails the 3/5 line.
    expect(m.tasks.abandoned).toBe(1);
    expect(m.tasks.corrected).toBe(1);
    expect(m.tasks.accepted).toBe(3);
    expect(m.fpar).toBe(3 / 5);
    expect(m.correction).toEqual({ corrected: 1, delivered: 5, rate: 1 / 5 });
    // revert-check: window on closed_at alone → the open task's NULL never
    // compares true and `open` reads 0; the delivered task likewise vanishes
    // from the T(9)-bounded window below.
    expect(m.tasks.open).toBe(1);
    expect(m.tasks.delivered).toBe(0);
    const wider = computeMetrics(db, { since: T(1), until: T(9) });
    expect(wider.tasks.delivered).toBe(1);
    expect(wider.tasks.open).toBe(1);
    // A bare date as `until` excludes that whole day (prefix comparison).
    const none = computeMetrics(db, { until: "2026-09-01" });
    expect(none.tasks.accepted).toBe(0);
    expect(none.tasks.open).toBe(0);
    expect(none.sessions.total).toBe(0);
    const all = computeMetrics(db, { since: "2026-09-01" });
    expect(all.tasks.accepted).toBe(3);
    expect(all.tasks.delivered).toBe(1);
    db.close();
  });

  it("overhead ratio is null when the window holds no product spend, even with eval spend present", () => {
    const db = openDb(":memory:");
    seed(db);
    evalRun(db, T(9), [500]);
    const m = computeMetrics(db, { since: T(8) });
    expect(m.overhead.eval_spend_micro_usd).toBe(500);
    expect(m.overhead.product_spend_micro_usd).toBe(0);
    expect(m.overhead.unpriced_steps).toBe(0);
    // revert-check: divide unguarded → Infinity fails the schema parse
    // inside computeMetrics before this line is reached.
    expect(m.overhead.ratio).toBeNull();
    db.close();
  });
});
