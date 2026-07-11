import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@obligato/kernel";
import {
  UiBenchView,
  UiEvalView,
  UiLoopView,
  UiTelemetryView,
  UiTraceView,
} from "@obligato/schemas";
import { API_PATHS, createUiServer } from "../../src/ui/server.ts";

const SCHEMAS = {
  "/api/telemetry": UiTelemetryView,
  "/api/evals": UiEvalView,
  "/api/bench": UiBenchView,
  "/api/loop": UiLoopView,
  "/api/trace": UiTraceView,
} as const;

const dir = mkdtempSync(join(tmpdir(), "obligato-ux11-"));
const dbPath = join(dir, "k.db");
openDb(dbPath).close(); // migrate
const server = createUiServer({ dbPath, port: 0 });
afterAll(() => server.stop(true));

describe("UX-11: every obligato ui API response validates against its paired schema; failure returns 500, never an invalid body", () => {
  it("the route matrix and the schema pairing cover each other exactly", () => {
    expect(API_PATHS.toSorted()).toEqual(Object.keys(SCHEMAS).toSorted());
  });

  it("every route's live response parses with its paired schema", async () => {
    for (const [path, schema] of Object.entries(SCHEMAS)) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      const body = await res.json();
      const parsed = schema.safeParse(body);
      expect(
        parsed.success,
        `${path} failed: ${parsed.success ? "" : parsed.error.message}`,
      ).toBe(true);
    }
  });

  it("fault injection: a corrupted store row yields 500 with the fixed envelope, no partial body", async () => {
    const db = openDb(dbPath);
    // negative cost violates MicroUsd (int nonnegative) — the view builds,
    // the schema rejects, the wrapper must return the envelope
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort,
        agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
        unit_prices, cost_micro_usd, budget_tokens, overrun, schema_version)
       VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 't1', 's1', 'build', 'm', 'low',
        'a', 1, 1, 0, 0, '{}', -5, 100, 'none', 1)`,
    ).run();
    db.close();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/telemetry`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toEqual({
      error: "response_validation_failed",
      route: "/api/telemetry",
    });
  });
});
