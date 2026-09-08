import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooks } from "../../src/hooks.ts";
import { runTurn } from "../../src/loop.ts";
import { listEvents } from "../../src/sessions.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { hook, hookRuns, hookScript } from "../hook-helpers.ts";

const bashCall = (id: string, command: string) =>
  toolCallResponse([{ id, name: "bash", input: { command } }]);

describe("AGT-20: hooks load from .obligato/hooks.json, run per lifecycle event with the payload on stdin, and every run is recorded", () => {
  it("one hook per event: each matching run is recorded once with event, exit code, duration; the mismatched matcher neither runs nor records", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "obligato-hooks-")));
    const hooks = [
      hook("session_start", hookScript(dir, "start", 'echo "from start"')),
      hook(
        "pre_tool",
        hookScript(dir, "pre", "cat > pre.json; touch pre.marker"),
        {
          matcher: "bash",
        },
      ),
      hook("post_tool", hookScript(dir, "post", "cat > post.json"), {
        matcher: "bash",
      }),
      hook("pre_tool", hookScript(dir, "nomatch", "touch nomatch.marker"), {
        matcher: "write",
      }),
      hook("session_end", hookScript(dir, "end", "touch end.marker")),
    ];
    const f = fixture([bashCall("h20a", "echo hi"), textResponse("done")], {
      hooks,
    });
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");

    // Chain records: pre, post, session_end — exactly one each.
    const runs = hookRuns(f.db, f.sessionId);
    // revert-check: drop recordHookRun in resolveTools → this reads [session_end] only.
    expect(runs.map((r) => r.event)).toEqual([
      "pre_tool",
      "post_tool",
      "session_end",
    ]);
    for (const r of runs) {
      expect(r.exit_code).toBe(0);
      expect(r.blocked).toBe(false);
      expect(typeof r.duration_ms).toBe("number");
      expect(r.duration_ms as number).toBeGreaterThanOrEqual(0);
    }
    expect(runs[0]?.tool).toBe("bash");
    expect(runs[2]?.tool).toBeUndefined();
    // session_start rides on the root payload (a later event would fork).
    const root = listEvents(f.db, f.sessionId)[0];
    expect(root?.payload.hook_runs).toEqual([
      expect.objectContaining({
        event: "session_start",
        exit_code: 0,
        blocked: false,
      }),
    ]);
    expect(String(root?.payload.system)).toContain("from start");
    // The write-matcher hook never ran and never recorded.
    expect(existsSync(join(f.dir, "nomatch.marker"))).toBe(false);
    expect(runs.some((r) => String(r.command).includes("nomatch"))).toBe(false);
    expect(existsSync(join(f.dir, "end.marker"))).toBe(true);
  }, 30_000);

  it("the stdin payload carries event, session_id, tool, and the raw input (pre) plus output/is_error (post); OBLIGATO_SESSION_ID is in the env", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "obligato-hooks-")));
    const hooks = [
      hook(
        "pre_tool",
        hookScript(
          dir,
          "pre",
          'cat > pre.json; echo "$OBLIGATO_SESSION_ID" > sid.txt',
        ),
      ),
      hook("post_tool", hookScript(dir, "post", "cat > post.json")),
    ];
    const f = fixture([bashCall("h20b", "echo payload"), textResponse("ok")], {
      hooks,
    });
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    const pre = JSON.parse(readFileSync(join(f.dir, "pre.json"), "utf8"));
    // revert-check: interpolate instead of stdin → pre.json is empty and parse throws.
    expect(pre).toEqual({
      event: "pre_tool",
      session_id: f.sessionId,
      tool: "bash",
      input: { command: "echo payload" },
    });
    const post = JSON.parse(readFileSync(join(f.dir, "post.json"), "utf8"));
    expect(post.event).toBe("post_tool");
    expect(post.tool).toBe("bash");
    expect(String(post.output)).toContain("payload");
    expect(post.is_error).toBe(false);
    expect(readFileSync(join(f.dir, "sid.txt"), "utf8").trim()).toBe(
      f.sessionId,
    );
  }, 30_000);

  it("a repo without hooks.json loads [] and a turn records no hook runs; an invalid file throws at load", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "obligato-hooks-")));
    expect(loadHooks(dir)).toEqual([]);
    const f = fixture([bashCall("h20c", "echo none"), textResponse("ok")]);
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    expect(hookRuns(f.db, f.sessionId)).toEqual([]);
    expect(listEvents(f.db, f.sessionId)[0]?.payload.hook_runs).toBeUndefined();

    mkdirSync(join(dir, ".obligato"), { recursive: true });
    writeFileSync(
      join(dir, ".obligato", "hooks.json"),
      JSON.stringify({
        schema_version: 1,
        hooks: [{ event: "nope", command: "x" }],
      }),
    );
    expect(() => loadHooks(dir)).toThrow();
    // A valid file round-trips its entries.
    writeFileSync(
      join(dir, ".obligato", "hooks.json"),
      JSON.stringify({
        schema_version: 1,
        hooks: [{ event: "pre_tool", matcher: "bash", command: "true" }],
      }),
    );
    expect(loadHooks(dir)).toEqual([
      { event: "pre_tool", matcher: "bash", command: "true" },
    ]);
  }, 30_000);

  it("the api executor runs hook-less: hooks: [] at creation and turn, never loadHooks (SEC-1 boundary)", async () => {
    const src = await Bun.file(
      join(import.meta.dir, "..", "..", "src", "executor.ts"),
    ).text();
    // revert-check: load the snapshot's hooks in the executor → loadHooks appears.
    expect(src).not.toContain("loadHooks");
    expect(src.split("hooks: [],").length - 1).toBe(2);
  });
});
