import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@obligato/agent";
import { ingestStepEvent, openDb, sessionView } from "@obligato/kernel";
import { UiSessionView } from "@obligato/schemas";
import { API_PATHS, createUiServer } from "../../src/ui/server.ts";
import { LOCK, seedTimelineSession, stepRow } from "../timeline-helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "obligato-ux50-"));
const dbPath = join(dir, "k.db");
const db = openDb(dbPath);
const fx = seedTimelineSession(db);
const server = createUiServer({ dbPath, port: 0 });
afterAll(() => {
  server.stop(true);
  db.close();
});

describe("UX-50: session timeline view — rowid stream across branches, budget items appended, null-honest cost", () => {
  it("maps every event to its pinned variant in rowid order; the fork's event is present; budget items come last", () => {
    const view = sessionView(db, fx.sessionId);
    expect(UiSessionView.safeParse(view).success).toBe(true);
    // revert-check: filter items to the reconstructed chain → the on-fork
    // `user` at index 7 vanishes and this kinds list shrinks by one.
    expect(view.items.map((i) => i.kind)).toEqual([
      "user",
      "step",
      "tool",
      "permission",
      "permission",
      "model_switch",
      "step",
      "tool",
      "fork",
      "user",
      "budget",
    ]);
    expect(view.items.map((i) => i.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const [
      user,
      step,
      tool,
      req,
      dec,
      sw,
      priced,
      failedTool,
      fork,
      onFork,
      budget,
    ] = view.items;
    expect(priced).toMatchObject({
      kind: "step",
      id: fx.pricedStep,
      model: "claude-sonnet-4-5-20250929",
      cost_micro_usd: 1234,
      tool_calls: 1,
    });
    expect(failedTool).toMatchObject({
      kind: "tool",
      name: "bash",
      ok: false,
      detail: "boom",
    });
    expect(user).toMatchObject({ kind: "user", preview: "hello" });
    expect(step).toMatchObject({
      kind: "step",
      id: fx.step,
      model: "mock-m",
      tokens_in: 10,
      tokens_out: 5,
      cost_micro_usd: null,
      tool_calls: 1,
      preview: "reading",
    });
    expect(tool).toMatchObject({
      kind: "tool",
      name: "read",
      ok: true,
      detail: "line1",
    });
    expect(req).toMatchObject({
      kind: "permission",
      phase: "request",
      tool: "bash",
      detail: "rm x",
    });
    expect(dec).toMatchObject({
      kind: "permission",
      phase: "decision",
      tool: "bash",
      detail: "deny",
    });
    expect(sw).toMatchObject({
      kind: "model_switch",
      from: "mock-m",
      to: "mock-n",
    });
    expect(fork).toMatchObject({
      kind: "fork",
      id: fx.forkHead,
      from_event: fx.step,
    });
    expect(onFork).toMatchObject({ kind: "user", id: fx.onFork });
    // The overrun was recorded mid-stream: its `at` precedes the last session
    // item's, yet it sorts last — concatenation, never timestamp interleave.
    // revert-check: merge budget rows by `at` into the event stream → the
    // budget item lands before the on-fork user and the kinds list above
    // (and the strict `at` comparison below) fail.
    expect(budget).toMatchObject({ kind: "budget", event: "overrun" });
    expect(budget !== undefined && onFork !== undefined).toBe(true);
    expect((budget?.at ?? "") < (onFork?.at ?? "")).toBe(true);
    expect(budget?.kind === "budget" ? budget.detail : "").toContain(
      "1× budget",
    );
  });

  it("header: an unpriced step makes the total null (never a partial sum) while steps still counts it", () => {
    const view = sessionView(db, fx.sessionId);
    expect(view.session).not.toBeNull();
    // revert-check: drop the `unpriced > 0 → null` rule → cost reads 0 here.
    expect(view.session?.cost_micro_usd).toBeNull();
    expect(view.session?.unpriced_steps).toBe(1);
    expect(view.session?.steps).toBe(1);
    expect(view.session?.tokens).toBe(15);
    expect(view.session).toMatchObject({
      id: fx.sessionId,
      repo: "test-repo",
      runner: "native",
      model: "mock-m",
      auth_kind: "none",
    });
  });

  it("an all-priced session sums by hand: 100 + 250 = 350", () => {
    const { sessionId, taskId } = createAgentSession(db, {
      repo: "priced-repo",
      lockfile_hash: LOCK,
      harness_version: "0.0.1",
      model: "mock-m",
      system: "sys",
      auth_kind: "api_key",
    });
    ingestStepEvent(db, stepRow(sessionId, taskId, 100));
    ingestStepEvent(db, stepRow(sessionId, taskId, 250));
    const view = sessionView(db, sessionId);
    expect(view.session?.cost_micro_usd).toBe(350);
    expect(view.session?.unpriced_steps).toBe(0);
    expect(view.session?.steps).toBe(2);
    expect(view.items).toEqual([]);
  });

  it("GET /api/session/<id> is the same function's return, schema-valid; unknown id → the empty shape", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/session/${fx.sessionId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(UiSessionView.safeParse(body).success).toBe(true);
    // identity: the route serves exactly what the kernel function returns
    expect(body).toEqual(
      JSON.parse(JSON.stringify(sessionView(db, fx.sessionId))),
    );
    const missing = await fetch(
      `http://127.0.0.1:${server.port}/api/session/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      empty_verb: "obligato chat",
      session: null,
      items: [],
    });
  });

  it("the registered-route list carries the example path so the UX-10/11/12 matrices iterate it", () => {
    // revert-check: drop patternRoutes from API_PATHS → this fails and UX-10's
    // 405 sweep silently skips the parameterised route.
    expect(API_PATHS).toContain("/api/session/01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
});
