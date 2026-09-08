import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import {
  hook,
  hookErrors,
  hookRuns,
  hookScript,
  sessionStatus,
  toolResults,
} from "../hook-helpers.ts";

const bashCall = (id: string, command: string) =>
  toolCallResponse([{ id, name: "bash", input: { command } }]);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "obligato-h22-")));

describe("AGT-22: a hook that fails to run (timeout / non-0,2 exit / spawn error) is skipped, recorded as hook_error, and degrades the session — never a crash, never a block", () => {
  it("a pre_tool hook past its timeout: tool executes, later hooks still run, hook_error(timeout) recorded, session degraded", async () => {
    const dir = tmp();
    const f = fixture(
      [bashCall("h22a", "touch ran.marker"), textResponse("ok")],
      {
        hooks: [
          hook("pre_tool", hookScript(dir, "slow", "sleep 3"), {
            matcher: "bash",
            timeout_ms: 200,
          }),
          hook("pre_tool", hookScript(dir, "later", "touch later.marker"), {
            matcher: "bash",
          }),
        ],
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    expect(existsSync(join(f.dir, "ran.marker"))).toBe(true);
    expect(existsSync(join(f.dir, "later.marker"))).toBe(true);
    expect(toolResults(f.db, f.sessionId)[0]?.payload.is_error).toBe(false);
    // revert-check: treat a timeout as a block or throw → ran.marker absent / runTurn rejects.
    expect(hookErrors(f.db, f.sessionId)).toEqual([
      expect.objectContaining({ event: "pre_tool", reason: "timeout" }),
    ]);
    // Read the row back: degraded, and it stays degraded past endSession.
    expect(sessionStatus(f.db, f.sessionId)).toBe("degraded");
  }, 30_000);

  it("a hook exiting 1: reason exit:1, tool executed, degraded", async () => {
    const dir = tmp();
    const f = fixture(
      [bashCall("h22b", "touch ran.marker"), textResponse("ok")],
      {
        hooks: [
          hook("pre_tool", hookScript(dir, "one", "exit 1"), {
            matcher: "bash",
          }),
        ],
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    expect(existsSync(join(f.dir, "ran.marker"))).toBe(true);
    expect(hookErrors(f.db, f.sessionId)).toEqual([
      expect.objectContaining({ event: "pre_tool", reason: "exit:1" }),
    ]);
    expect(hookRuns(f.db, f.sessionId)).toEqual([]);
    expect(sessionStatus(f.db, f.sessionId)).toBe("degraded");
  }, 30_000);

  it("a failing session_start hook degrades at creation and records hook_errors on the root", async () => {
    const dir = tmp();
    const f = fixture([textResponse("ok")], {
      hooks: [hook("session_start", hookScript(dir, "boom", "exit 3"))],
    });
    expect(sessionStatus(f.db, f.sessionId)).toBe("degraded");
    const { listEvents } = await import("../../src/sessions.ts");
    const root = listEvents(f.db, f.sessionId)[0];
    expect(root?.payload.hook_errors).toEqual([
      expect.objectContaining({ event: "session_start", reason: "exit:3" }),
    ]);
    expect(root?.payload.hook_runs).toBeUndefined();
  });

  it("discriminating arm: a healthy exit-0 hook leaves the session un-degraded (complete after the done turn) with no hook_error", async () => {
    const dir = tmp();
    const f = fixture(
      [bashCall("h22c", "touch ran.marker"), textResponse("ok")],
      {
        hooks: [
          hook("pre_tool", hookScript(dir, "fine", "exit 0"), {
            matcher: "bash",
          }),
        ],
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    // revert-check: degrade on every hook run → this reads "degraded".
    expect(sessionStatus(f.db, f.sessionId)).toBe("complete");
    expect(hookErrors(f.db, f.sessionId)).toEqual([]);
    expect(hookRuns(f.db, f.sessionId)).toHaveLength(1);
  }, 30_000);
});
