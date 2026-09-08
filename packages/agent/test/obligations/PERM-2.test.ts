import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { answerPermission, resume, runTurn } from "../../src/loop.ts";
import { listEvents, reconstruct } from "../../src/sessions.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import {
  fixture,
  mockModel,
  TEST_ENTRY,
  textResponse,
  toolCallResponse,
} from "../helpers.ts";

describe("PERM-2: ask flow lives entirely in session events; always-allow is a scoped-rule event", () => {
  it("request, decision, and scoped-rule events land in order; the repeat call needs no new request; no config file appears", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "1" } },
      ]),
      toolCallResponse([
        { id: "c2", name: "write", input: { path: "b.txt", content: "2" } },
      ]),
      textResponse("done"),
    ]);
    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const request = chain.find((e) => e.kind === "permission_request");
    expect(request).toBeDefined();
    if (!request) return;
    answerPermission(f.db, f.sessionId, request.id, "allow", true);

    const done = await resume({
      db: f.db,
      sessionId: f.sessionId,
      entry: TEST_ENTRY,
      model: f.model,
      tools: CORE_TOOLS,
      rules: [],
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    });
    expect(done.status).toBe("done");

    const events = listEvents(f.db, f.sessionId);
    const kindsInOrder = events
      .filter(
        (e) =>
          ["permission_request", "permission_decision"].includes(e.kind) ||
          (e.kind === "session_meta" && e.payload.scoped_rule !== undefined),
      )
      .map((e) => e.kind);
    expect(kindsInOrder).toEqual([
      "permission_request",
      "permission_decision",
      "session_meta",
    ]);

    // The second write (c2) proceeded under the scoped rule — one request total.
    expect(events.filter((e) => e.kind === "permission_request").length).toBe(
      1,
    );
    expect(
      events.filter(
        (e) => e.kind === "tool_result" && e.payload.tool_call_id === "c2",
      ).length,
    ).toBe(1);

    // Never a config-file write.
    expect(existsSync(join(f.dir, ".obligato", "permissions.json"))).toBe(
      false,
    );
  });

  it("guard flow (PERM-6 amendment): always-allow on a guard ask records the literal arg; the identical guard-prefix command proceeds without a new request; a different guarded command still asks", async () => {
    const same = "git reset --hard";
    const other = "git reset --hard HEAD~1";
    const bash = (id: string, command: string) =>
      toolCallResponse([{ id, name: "bash", input: { command } }]);
    const f = fixture([
      bash("g1", same),
      bash("g2", same),
      bash("g3", other),
      textResponse("done"),
    ]);
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    expect((await runTurn(f.deps)).status).toBe("paused");
    const request = listEvents(f.db, f.sessionId).find(
      (e) => e.kind === "permission_request",
    );
    expect(request?.payload.arg).toBe(same);
    answerPermission(f.db, f.sessionId, request?.id as string, "allow", true);
    const scoped = listEvents(f.db, f.sessionId).find(
      (e) => e.kind === "session_meta" && e.payload.scoped_rule !== undefined,
    );
    // revert-check: drop the arg from the scoped rule → g2 re-asks (3 requests).
    expect(scoped?.payload.scoped_rule).toEqual({
      tool: "bash",
      arg: same,
      action: "allow",
    });
    expect((await runTurn(f.deps)).status).toBe("paused");
    const events = listEvents(f.db, f.sessionId);
    expect(
      events
        .filter((e) => e.kind === "permission_request")
        .map((e) => e.payload.arg),
    ).toEqual([same, other]);
    expect(
      events.filter(
        (e) => e.kind === "tool_result" && e.payload.tool_call_id === "g2",
      ),
    ).toHaveLength(1);
    expect(existsSync(join(f.dir, ".obligato", "permissions.json"))).toBe(
      false,
    );
  }, 30_000);
});
