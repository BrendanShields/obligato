import { describe, expect, it } from "bun:test";
import { WidgetTree } from "@obligato/schemas";
import { createTestRenderer } from "@opentui/core/testing";
import { compose } from "../../src/chat/compose.js";
import { unifiedSnippet } from "../../src/chat/diff.js";
import {
  type ChatEntry,
  type ChatModel,
  type ChatMsg,
  createChat,
  isFoldable,
  renderChat,
  update,
} from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { CHAT_THEME } from "../../src/chat/theme.js";

const g = CHAT_THEME.glyphs;

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

const editEntry = (
  call: Record<string, unknown>,
  ok = true,
): ChatEntry & { kind: "tool" } => ({
  kind: "tool",
  name: "edit",
  ok,
  output: "replaced 1 occurrence(s) in p",
  expanded: false,
  call,
});

// The loop arm (onToolStart's third argument) lives in
// packages/agent/test/obligations/UX-47.test.ts.
describe("UX-47: diff widgets for edit/write — call plumbing, composer rule 2, one fold path", () => {
  it("reducer: tool_start{input} → tool_result copies input onto the entry's call; a bare result has none", () => {
    const input = { path: "a.txt", content: "x" };
    let m = feed(createChat("mock-m", {}, []), [
      { type: "submit", text: "go" },
      { type: "tool_start", name: "write", arg: "a.txt", input },
      { type: "tool_result", name: "write", ok: true, output: "wrote a.txt" },
    ]);
    const entry = m.entries.find((e) => e.kind === "tool");
    // revert-check: drop the `call` copy in tool_result → undefined here.
    expect(entry?.kind === "tool" && entry.call).toEqual(input);
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "",
    }).model;
    const bare = m.entries.filter((e) => e.kind === "tool")[1];
    expect(bare?.kind === "tool" && "call" in bare).toBe(false);
  });

  it("composer: a successful edit with a call composes a diff widget with the exact unified text", () => {
    const d = compose(editEntry({ path: "p", old: "a\nb", new: "c" }));
    expect(d.kind).toBe("widget");
    if (d.kind !== "widget") throw new Error("unreachable");
    // UX-28: the schema call is the test's own (F-031).
    expect(WidgetTree.parse(d.tree)).toEqual(d.tree);
    // revert-check: swap the +/- order → the literal differs.
    expect(d.tree.root).toEqual({
      type: "diff",
      unified: "--- p\n+++ p\n-a\n-b\n+c",
    });
    const failed = compose(editEntry({ path: "p", old: "a", new: "b" }, false));
    expect(failed.kind).toBe("identity");
  });

  it("write snippet: 40 `+` lines then the `… 10 more lines` trailer", () => {
    const content = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const lines = unifiedSnippet("write", { path: "w", content }).split("\n");
    expect(lines.slice(0, 2)).toEqual(["--- w", "+++ w"]);
    expect(
      lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")),
    ).toHaveLength(40);
    expect(lines.at(-1)).toBe("… 10 more lines");
  });

  it("fold: a 6-line diff folds through the UX-31 path and expands; a 3-line diff renders unfolded", () => {
    const six = editEntry({ path: "p", old: "a\nb", new: "c\nd" });
    expect(isFoldable(six)).toBe(true);
    let m: ChatModel = { ...createChat("mock-m", {}, []), entries: [six] };
    let view = renderChat(m);
    // revert-check: measure `output` instead of the diff → 1 line, no fold.
    expect(view).toContain(`${g.fold} edit ${g.ok} 6 lines (enter expands)`);
    expect(view).not.toContain("-a");
    m = update(m, { type: "toggle_fold", index: 0 }).model;
    view = renderChat(m);
    expect(view).toContain("-a");
    expect(view).toContain("+c");
    const three: ChatEntry & { kind: "tool" } = {
      kind: "tool",
      name: "write",
      ok: true,
      output: "wrote p",
      expanded: false,
      call: { path: "p", content: "z" },
    };
    expect(isFoldable(three)).toBe(false);
    expect(renderChat({ ...m, entries: [three] })).toContain("+z");
  });

  it("renderer: expanded frame carries -a/+c, collapsed does not; NO_COLOR keeps the lines", async () => {
    const six = editEntry({ path: "p", old: "a\nb", new: "c\nd" });
    for (const env of [{}, { NO_COLOR: "" }]) {
      const setup = await createTestRenderer({ width: 80, height: 24 });
      const surface = createSurface(setup.renderer, env);
      let m: ChatModel = { ...createChat("mock-m", {}, []), entries: [six] };
      surface.update(m);
      await setup.renderOnce();
      const collapsed = setup.captureCharFrame();
      expect(collapsed).toContain("6 lines (enter expands)");
      expect(collapsed).not.toContain("-a");
      m = update(m, { type: "toggle_fold", index: 0 }).model;
      surface.update(m);
      await setup.renderOnce();
      const expanded = setup.captureCharFrame();
      expect(expanded).toContain("-a");
      expect(expanded).toContain("+c");
      setup.renderer.destroy();
    }
  });
});
