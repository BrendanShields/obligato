import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerPermission, runTurn } from "../../src/loop.ts";
import { listEvents } from "../../src/sessions.ts";
import { loadSpecContext } from "../../src/spec.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { hook, hookRuns, hookScript, toolResults } from "../hook-helpers.ts";
import { markStale, seedSpec } from "../spec-helpers.ts";

const bashCall = (id: string, command: string) =>
  toolCallResponse([{ id, name: "bash", input: { command } }]);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "obligato-h21-")));

describe("AGT-21: pre_tool exit 2 blocks before the gate and execution; post_tool feeds output back; order permission → pre → gate → run → post", () => {
  it("(a) a matching pre_tool hook exiting 2 blocks: denied-shape result, marker absent, blocked recorded", async () => {
    const dir = tmp();
    const hooks = [
      hook("pre_tool", hookScript(dir, "block", 'echo "no rm" >&2; exit 2'), {
        matcher: "bash",
      }),
    ];
    const f = fixture(
      [bashCall("h21a", "touch ran.marker"), textResponse("ok")],
      {
        hooks,
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    const tr = toolResults(f.db, f.sessionId)[0];
    // revert-check: ignore exit 2 in resolveTools → output is "(no output)" and the marker exists.
    expect(tr?.payload.output).toBe("blocked by hook: no rm");
    expect(tr?.payload.is_error).toBe(true);
    expect(existsSync(join(f.dir, "ran.marker"))).toBe(false);
    expect(hookRuns(f.db, f.sessionId)[0]).toEqual(
      expect.objectContaining({
        event: "pre_tool",
        exit_code: 2,
        blocked: true,
      }),
    );
    // The hook_run precedes the tool_result on the chain.
    const kinds = listEvents(f.db, f.sessionId)
      .filter((e) => e.kind === "tool_result" || e.payload.hook_run)
      .map((e) => e.kind);
    expect(kinds).toEqual(["session_meta", "tool_result"]);
  }, 30_000);

  it("(b) order — the hook block wins over the AGT-8 gate on a governed T1 write; without the hook the gate fires", async () => {
    const writeCall = toolCallResponse([
      {
        id: "h21b",
        name: "write",
        input: { path: "src/governed.ts", content: "const x = 'SENTINEL';\n" },
      },
    ]);
    // Control: no hook → the gate blocks (stale confirmed T1 clause, AGT-8).
    const control = fixture([writeCall, textResponse("ok")]);
    control.deps.rules = [{ tool: "write", action: "allow" }];
    seedSpec(control.db, control.dir, { authority: "confirmed" });
    markStale(control.db, control.dir);
    control.deps.spec = loadSpecContext(control.db, control.dir);
    await runTurn(control.deps, 3);
    const gateOut = String(
      toolResults(control.db, control.sessionId)[0]?.payload.output,
    );
    expect(gateOut.startsWith("blocked:")).toBe(true);
    expect(gateOut.startsWith("blocked by hook:")).toBe(false);

    const dir = tmp();
    const hooks = [
      hook(
        "pre_tool",
        hookScript(dir, "block", 'echo "spec hook" >&2; exit 2'),
        {
          matcher: "write",
        },
      ),
    ];
    const f = fixture([writeCall, textResponse("ok")], { hooks });
    f.deps.rules = [{ tool: "write", action: "allow" }];
    const { governedAbs } = seedSpec(f.db, f.dir, { authority: "confirmed" });
    markStale(f.db, f.dir);
    const before = readFileSync(governedAbs, "utf8");
    f.deps.spec = loadSpecContext(f.db, f.dir);
    await runTurn(f.deps, 3);
    // revert-check: run the gate before hooks → this reads the gate's "blocked:" message.
    expect(toolResults(f.db, f.sessionId)[0]?.payload.output).toBe(
      "blocked by hook: spec hook",
    );
    expect(readFileSync(governedAbs, "utf8")).toBe(before);
  }, 30_000);

  it("(c) two pre hooks, the first blocks: the second never runs; (d) a mismatched matcher does not block", async () => {
    const dir = tmp();
    const f = fixture(
      [bashCall("h21c", "touch ran.marker"), textResponse("ok")],
      {
        hooks: [
          hook("pre_tool", hookScript(dir, "first", "exit 2"), {
            matcher: "bash",
          }),
          hook("pre_tool", hookScript(dir, "second", "touch second.marker"), {
            matcher: "bash",
          }),
        ],
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    expect(existsSync(join(f.dir, "second.marker"))).toBe(false);
    expect(existsSync(join(f.dir, "ran.marker"))).toBe(false);
    // Blocker with empty stderr names the command.
    expect(String(toolResults(f.db, f.sessionId)[0]?.payload.output)).toBe(
      `blocked by hook: sh ${join(dir, "first.sh")}`,
    );

    const g = fixture(
      [bashCall("h21d", "touch ran.marker"), textResponse("ok")],
      {
        hooks: [
          hook("pre_tool", hookScript(dir, "w", "exit 2"), {
            matcher: "write",
          }),
        ],
      },
    );
    g.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(g.deps);
    expect(existsSync(join(g.dir, "ran.marker"))).toBe(true);
  }, 30_000);

  it("(e) post_tool stdout is appended as [hook] text, identical on the chain and to the observer; (f) exit 2 appends stderr and latches is_error; later post hooks still run", async () => {
    const dir = tmp();
    const seen: string[] = [];
    const f = fixture([bashCall("h21e", "echo body"), textResponse("ok")], {
      hooks: [
        hook("post_tool", hookScript(dir, "lint", 'echo "lint ok"'), {
          matcher: "bash",
        }),
      ],
    });
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    f.deps.onToolResult = (_n, _ok, out) => void seen.push(out ?? "");
    await runTurn(f.deps);
    const out = String(toolResults(f.db, f.sessionId)[0]?.payload.output);
    // revert-check: drop the stdout append → out is "body" with no [hook] line.
    expect(out).toBe("body\n[hook] lint ok");
    expect(seen).toEqual([out]);
    expect(toolResults(f.db, f.sessionId)[0]?.payload.is_error).toBe(false);

    const g = fixture([bashCall("h21f", "echo body"), textResponse("ok")], {
      hooks: [
        hook("post_tool", hookScript(dir, "bad", 'echo "bad" >&2; exit 2'), {
          matcher: "bash",
        }),
        hook("post_tool", hookScript(dir, "later", 'echo "later ran"'), {
          matcher: "bash",
        }),
      ],
    });
    g.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(g.deps);
    const tr = toolResults(g.db, g.sessionId)[0];
    expect(tr?.payload.output).toBe("body\n[hook] bad\n[hook] later ran");
    expect(tr?.payload.is_error).toBe(true);
    expect(hookRuns(g.db, g.sessionId).map((r) => r.event)).toEqual([
      "post_tool",
      "post_tool",
    ]);
  }, 30_000);

  it("(g) an ask pauses before any hook runs; the answered allow runs the hook exactly once; (h) a denied call runs no pre hook and no post hook", async () => {
    const dir = tmp();
    const f = fixture([bashCall("h21g", "echo asked"), textResponse("ok")], {
      hooks: [
        hook("pre_tool", hookScript(dir, "pre", "touch pre.marker")),
        hook("post_tool", hookScript(dir, "post", "touch post.marker")),
      ],
    });
    f.deps.rules = [{ tool: "bash", action: "ask" }];
    const first = await runTurn(f.deps);
    expect(first.status).toBe("paused");
    // revert-check: run pre hooks before the ask resolves → pre.marker exists here.
    expect(existsSync(join(f.dir, "pre.marker"))).toBe(false);
    expect(hookRuns(f.db, f.sessionId)).toEqual([]);
    const request = listEvents(f.db, f.sessionId).find(
      (e) => e.kind === "permission_request",
    );
    answerPermission(f.db, f.sessionId, request?.id as string, "allow");
    const second = await runTurn(f.deps);
    expect(second.status).toBe("done");
    expect(existsSync(join(f.dir, "pre.marker"))).toBe(true);
    expect(existsSync(join(f.dir, "post.marker"))).toBe(true);
    expect(
      hookRuns(f.db, f.sessionId).filter((r) => r.event === "pre_tool"),
    ).toHaveLength(1);

    const g = fixture([bashCall("h21h", "echo denied"), textResponse("ok")], {
      hooks: [
        hook("pre_tool", hookScript(dir, "pre2", "touch pre.marker")),
        hook("post_tool", hookScript(dir, "post2", "touch post.marker")),
      ],
    });
    g.deps.rules = [{ tool: "bash", action: "deny" }];
    await runTurn(g.deps);
    expect(existsSync(join(g.dir, "pre.marker"))).toBe(false);
    expect(existsSync(join(g.dir, "post.marker"))).toBe(false);
    expect(String(toolResults(g.db, g.sessionId)[0]?.payload.output)).toContain(
      "denied by permission rule",
    );
  }, 30_000);
});
