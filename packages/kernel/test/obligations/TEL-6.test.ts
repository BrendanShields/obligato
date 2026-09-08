import { afterAll, describe, expect, it } from "bun:test";
import { exportMetricsOtel, exportSessionOtel } from "../../src/otel.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

const MARKER = "XOBLIGATO_SECRET_MARKERX";

const seedSessionWithSteps = (db: ReturnType<typeof openDb>): string => {
  const sessionId = ulid();
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, trace_id, started_at, ended_at)
     VALUES (?, 'r', ?, '0.1.0', 1, 'complete', NULL, ?, ?)`,
  ).run(
    sessionId,
    `sha256:${"a".repeat(64)}`,
    "2026-07-02T10:00:00Z",
    "2026-07-02T11:00:00Z",
  );
  for (const step of ["planning", "build", "verify"] as const)
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
       VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'medium', ?, 100, 50, 0, 0, '{}', 1234, 20000, 'none', ?, 1)`,
    ).run(
      ulid(),
      ulid(),
      sessionId,
      step,
      // Free-text-capable fields carry planted content that must not export.
      `src/${MARKER}/impl.ts`,
      `prompt: ${MARKER}`,
    );
  return sessionId;
};

// OTLP collector fixture. paths records the route per request so the metrics
// half can assert exactly one /v1/metrics POST.
const received: unknown[] = [];
const paths: string[] = [];
const collector = Bun.serve({
  port: 0,
  fetch: async (req) => {
    paths.push(new URL(req.url).pathname);
    received.push(await req.json());
    return new Response("{}", { status: 200 });
  },
});

// Hand-seeded metrics fixture: 2 accepted + 1 corrected (all delivered) →
// FPAR 2/3, correction 1/3; one 1234-µUSD step on each accepted task →
// TPAC 1234; tokens 150 each → 150 per accepted. The marker is planted in
// `model` — the one free-text field computeMetrics reads (cost_by_model) —
// so a regression that adds per-model gauge attributes fails the no-marker
// assertion; agent_id/span_id carry it too for the trace half.
const seedMetricsFixture = (db: ReturnType<typeof openDb>): void => {
  const sessionId = seedSessionWithSteps(db);
  const at = "2026-09-01T02:00:00.000Z";
  const accepted = [ulid(), ulid()];
  for (const id of accepted)
    db.query(
      `INSERT INTO task (id, repo, spec_clause_refs, state, acceptance_signal, correction_count, opened_at, delivered_at, closed_at)
       VALUES (?, 'r', '[]', 'accepted', 'approval', 0, ?, ?, ?)`,
    ).run(id, at, at, at);
  db.query(
    `INSERT INTO task (id, repo, spec_clause_refs, state, acceptance_signal, correction_count, opened_at, delivered_at, closed_at)
     VALUES (?, 'r', '[]', 'corrected', NULL, 1, ?, ?, ?)`,
  ).run(ulid(), at, at, at);
  for (const taskId of accepted)
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
       VALUES (?, ?, ?, 'build', ?, 'medium', ?, 100, 50, 0, 0, '{}', 1234, 20000, 'none', ?, 1)`,
    ).run(
      ulid(),
      taskId,
      sessionId,
      `model-${MARKER}`,
      `src/${MARKER}/x.ts`,
      `prompt: ${MARKER}`,
    );
};
afterAll(() => collector.stop());

describe("TEL-6: opt-in OTel projection — one trace per session, one span per step, TEL-3-stripped attributes", () => {
  it("a session exports one trace with a span per step carrying token/cost attributes and no planted markers", async () => {
    const db = openDb(":memory:");
    const sessionId = seedSessionWithSteps(db);
    const result = await exportSessionOtel(
      db,
      sessionId,
      `http://localhost:${collector.port}`,
    );
    expect(result.traces).toBe(1);
    expect(result.spans).toBe(3);
    expect(received).toHaveLength(1);
    const payload = JSON.stringify(received[0]);
    expect(payload).not.toContain(MARKER);
    const doc = received[0] as {
      resourceSpans: {
        scopeSpans: {
          spans: { traceId: string; attributes: { key: string }[] }[];
        }[];
      }[];
    };
    const spans = doc.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(3);
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
    for (const span of spans) {
      const keys = span.attributes.map((a) => a.key);
      expect(keys).toContain("obligato.tokens_in");
      expect(keys).toContain("obligato.cost_micro_usd");
    }
    db.close();
  });

  it("metrics half: one /v1/metrics POST carrying exactly the ERD §8 gauges of the non-null TEL-8 metrics, hand-known values, no markers", async () => {
    const db = openDb(":memory:");
    seedMetricsFixture(db);
    const before = paths.length;
    const result = await exportMetricsOtel(
      db,
      `http://localhost:${collector.port}`,
    );
    expect(paths.slice(before)).toEqual(["/v1/metrics"]);
    const body = received[received.length - 1] as {
      resourceMetrics: {
        resource: { attributes: { key: string; value: unknown }[] };
        scopeMetrics: {
          metrics: {
            name: string;
            gauge: {
              dataPoints: {
                asDouble?: number;
                asInt?: string;
                attributes: unknown[];
              }[];
            };
          }[];
        }[];
      }[];
    };
    expect(JSON.stringify(body)).not.toContain(MARKER);
    const rm = body.resourceMetrics[0];
    expect(rm?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "obligato" } },
    ]);
    const metrics = rm?.scopeMetrics[0]?.metrics ?? [];
    // Every ERD §8 name except the null gate pass rate (no verdicts seeded).
    // revert-check: emit null metrics as 0 → obligato.eval.gate.pass_rate
    // appears and this set equality fails.
    expect(metrics.map((m) => m.name).sort()).toEqual(
      [
        "obligato.fpar",
        "obligato.tpac",
        "obligato.tokens_per_accepted",
        "obligato.correction_rate",
        "obligato.overhead_ratio",
        "obligato.routing.regret",
        "obligato.drift.count",
        "obligato.interventions.count",
        "obligato.eval.gate.pass",
        "obligato.eval.gate.reject",
        "obligato.eval.gate.underpowered",
        "obligato.tasks.accepted",
        "obligato.sessions.count",
        "obligato.sessions.degraded",
      ].sort(),
    );
    expect(result.gauges).toBe(14);
    const point = (name: string) =>
      metrics.find((m) => m.name === name)?.gauge.dataPoints[0];
    expect(point("obligato.fpar")?.asDouble).toBe(2 / 3);
    expect(point("obligato.tpac")?.asDouble).toBe(1234);
    expect(point("obligato.tokens_per_accepted")?.asDouble).toBe(150);
    expect(point("obligato.correction_rate")?.asDouble).toBe(1 / 3);
    // eval spend 0 over product spend 5 × 1234 → a measured 0, present.
    expect(point("obligato.overhead_ratio")?.asDouble).toBe(0);
    expect(point("obligato.tasks.accepted")?.asInt).toBe("2");
    expect(point("obligato.sessions.count")?.asInt).toBe("1");
    for (const m of metrics)
      expect(m.gauge.dataPoints[0]?.attributes).toEqual([]);
    db.close();
  });

  it("metrics half on an empty store: every rate is absent (never 0), counters read 0", async () => {
    const db = openDb(":memory:");
    const before = paths.length;
    await exportMetricsOtel(db, `http://localhost:${collector.port}`);
    expect(paths.slice(before)).toEqual(["/v1/metrics"]);
    const body = received[received.length - 1] as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: {
            name: string;
            gauge: { dataPoints: { asInt?: string }[] };
          }[];
        }[];
      }[];
    };
    const names = (body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []).map(
      (m) => m.name,
    );
    expect(names).not.toContain("obligato.fpar");
    expect(names).not.toContain("obligato.tpac");
    expect(names).toContain("obligato.tasks.accepted");
    db.close();
  });

  it("off by default: nothing in the harness calls the exporter ambiently", async () => {
    // Structural: the only network-capable kernel module is otel.ts and its
    // single export requires an explicit endpoint argument.
    const src = await Bun.file(
      new URL("../../src/otel.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain("endpoint: string");
    const before = received.length;
    // Opening a db and running a session records nothing outbound.
    const db = openDb(":memory:");
    seedSessionWithSteps(db);
    db.close();
    expect(received.length).toBe(before);
  });
});
