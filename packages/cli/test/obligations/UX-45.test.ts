import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandMenu } from "../../src/chat/menu.js";
import {
  type ChatModel,
  type ChatMsg,
  createChat,
  update,
} from "../../src/chat/model.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import { promptGlyph } from "../../src/chat/view.js";

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

// A model whose submits never go busy: history is reducer state, so feed
// turn_done after each send to keep the next submit accepted.
const idle = (m: ChatModel): ChatModel =>
  m.busy ? update(m, { type: "turn_done", status: "done" }).model : m;

const submit = (m: ChatModel, text: string): ChatModel =>
  idle(update(m, { type: "submit", text }).model);

describe("UX-45: composer history, backslash continuation, tab slash completion", () => {
  it("history: consecutive duplicates collapse; up recalls newest→oldest, clamps; down returns to the draft", () => {
    let m = submit(submit(submit(createChat("mock-m", {}, []), "a"), "b"), "b");
    expect(m.history).toEqual(["a", "b"]);
    let r = update(m, { type: "key", key: "up", input: "" });
    expect(r.effects).toEqual([{ type: "set_input", text: "b" }]);
    expect(r.model.historyIndex).toBe(1);
    expect(r.model.draft).toBe("");
    m = r.model;
    r = update(m, { type: "key", key: "up", input: "b" });
    expect(r.effects).toEqual([{ type: "set_input", text: "a" }]);
    m = r.model;
    // revert-check: drop the `idx <= 0` clamp → a third up emits set_input.
    r = update(m, { type: "key", key: "up", input: "a" });
    expect(r.effects).toEqual([]);
    expect(r.model).toBe(m);
    r = update(m, { type: "key", key: "down", input: "a" });
    expect(r.effects).toEqual([{ type: "set_input", text: "b" }]);
    m = r.model;
    r = update(m, { type: "key", key: "down", input: "b" });
    expect(r.effects).toEqual([{ type: "set_input", text: "" }]);
    expect(r.model.historyIndex).toBeNull();
  });

  it("history: a modified input, a non-empty unbrowsed input, and transcript focus are all no-ops", () => {
    let m = submit(submit(createChat("mock-m", {}, []), "a"), "b");
    m = update(m, { type: "key", key: "up", input: "" }).model; // at "b"
    // revert-check: drop the unmodified check → "bx" would recall "a".
    const modified = update(m, { type: "key", key: "up", input: "bx" });
    expect(modified.effects).toEqual([]);
    expect(modified.model).toBe(m);
    const fresh = submit(createChat("mock-m", {}, []), "a");
    expect(
      update(fresh, { type: "key", key: "up", input: "typed" }).effects,
    ).toEqual([]);
    const transcript = { ...fresh, focus: "transcript" as const };
    expect(
      update(transcript, { type: "key", key: "up", input: "" }).effects,
    ).toEqual([]);
  });

  it("continuation: `line1\\` then `line2` sends one user message with the glyph swapped between them", () => {
    const m0 = createChat("mock-m", {}, []);
    expect(promptGlyph(m0)).toBe(CHAT_THEME.glyphs.user);
    const r1 = update(m0, { type: "submit", text: "line1\\" });
    expect(r1.effects).toEqual([]);
    expect(r1.model.composing).toEqual(["line1"]);
    expect(r1.model.busy).toBe(false);
    expect(promptGlyph(r1.model)).toBe(CHAT_THEME.glyphs.cont);
    const r2 = update(r1.model, { type: "submit", text: "line2" });
    // revert-check: skip the join → the effect text reads "line2" only.
    expect(r2.effects).toEqual([{ type: "send_user", text: "line1\nline2" }]);
    expect(r2.model.composing).toEqual([]);
    expect(r2.model.entries[0]).toEqual({ kind: "user", text: "line1\nline2" });
  });

  it("continuation edges: two trailing backslashes submit; a joined `/exit` is a message; busy rejects", () => {
    const m0 = createChat("mock-m", {}, []);
    expect(update(m0, { type: "submit", text: "x\\\\" }).effects).toEqual([
      { type: "send_user", text: "x\\\\" },
    ]);
    const r = feed(m0, [{ type: "submit", text: "/exit\\" }]);
    const r2 = update(r, { type: "submit", text: "now" });
    expect(r2.effects).toEqual([{ type: "send_user", text: "/exit\nnow" }]);
    expect(r2.model.exited).toBe(false);
    const busy = update(m0, { type: "submit", text: "go" }).model;
    const rejected = update(busy, { type: "submit", text: "more\\" });
    expect(rejected.model.composing).toEqual([]);
    expect(rejected.model.entries.at(-1)?.kind).toBe("info");
    // history recall is a no-op while composing
    const composing = update(submit(m0, "a"), {
      type: "submit",
      text: "l\\",
    }).model;
    expect(
      update(composing, { type: "key", key: "up", input: "" }).effects,
    ).toEqual([]);
  });

  it("tab: one match completes inline, several open the filtered menu, none is a no-op, empty toggles focus", () => {
    const m = createChat("mock-m", {}, []);
    expect(
      update(m, { type: "key", key: "tab", input: "/mo" }).effects,
    ).toEqual([{ type: "set_input", text: "/model " }]);
    // revert-check: drop the filter from the menu effect → deep-equal fails.
    expect(update(m, { type: "key", key: "tab", input: "/" }).effects).toEqual([
      { type: "menu", filter: "/" },
    ]);
    expect(
      update(m, { type: "key", key: "tab", input: "/zzz" }).effects,
    ).toEqual([]);
    const toggled = update(m, { type: "key", key: "tab", input: "" });
    expect(toggled.model.focus).toBe("transcript");
    expect(toggled.effects).toEqual([]);
  });

  it("renderer: a filtered menu renders only the matching rows", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    createCommandMenu(
      setup.renderer,
      {},
      () => {},
      () => {},
      "/t",
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("/tree");
    // revert-check: ignore the filter → /help renders too.
    expect(frame).not.toContain("/help");
    setup.renderer.destroy();
  });
});
