import { describe, expect, it } from "bun:test";
import { bellBytes } from "../../src/chat/app.js";
import {
  type ChatModel,
  type ChatMsg,
  createChat,
  update,
} from "../../src/chat/model.js";

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

// The loop arm (abort → nothing appended, resend carries both user messages)
// lives in packages/agent/test/obligations/UX-44.test.ts (UX-36 precedent).
describe("UX-44: interrupt classification and the turn-boundary bell", () => {
  it("interrupted on a busy model closes the open activity at the pre-reset tick and appends the pinned info", () => {
    let m = feed(createChat("mock-m", {}, []), [
      { type: "submit", text: "go" },
      { type: "tick" },
      { type: "tick" },
      { type: "tick" },
      { type: "tool_start", name: "bash", arg: "bun test" },
      { type: "tick" },
      { type: "tick" },
    ]);
    expect(m.busy).toBe(true);
    expect(m.tickCount).toBe(5);
    const r = update(m, { type: "interrupted" });
    m = r.model;
    expect(m.busy).toBe(false);
    expect(m.tickCount).toBe(0);
    // revert-check: close the item after the tick reset → endTick 0 < startTick 3.
    expect(m.activity[0]).toEqual({
      name: "bash",
      arg: "bun test",
      startTick: 3,
      endTick: 5,
      ok: false,
    });
    expect(m.entries.at(-1)).toEqual({
      kind: "info",
      text: "interrupted — in-flight model output discarded; resend to continue",
    });
    expect(r.effects).toEqual([{ type: "bell" }]);
  });

  it("bell effect on turn_done, error, interrupted, paused — absent for delta", () => {
    const busy = update(createChat("mock-m", {}, []), {
      type: "submit",
      text: "go",
    }).model;
    const has = (msg: ChatMsg): boolean =>
      update(busy, msg).effects.some((e) => e.type === "bell");
    // revert-check: drop the bell from turn_done → the first assertion fails.
    expect(has({ type: "turn_done", status: "done" })).toBe(true);
    expect(has({ type: "error", message: "boom" })).toBe(true);
    expect(has({ type: "interrupted" })).toBe(true);
    expect(
      has({
        type: "paused",
        ask: { requestId: "r1", tool: "write", arg: "a", rule: "default" },
      }),
    ).toBe(true);
    expect(has({ type: "delta", text: "x" })).toBe(false);
  });

  it("bellBytes: BEL by default, nothing under OBLIGATO_NO_BELL (presence semantics)", () => {
    expect(bellBytes({})).toBe("\x07");
    // revert-check: truthiness instead of presence → "" would still ring.
    expect(bellBytes({ OBLIGATO_NO_BELL: "" })).toBe("");
  });
});
