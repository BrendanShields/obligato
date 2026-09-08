import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  type ChatModel,
  type ChatMsg,
  createChat,
  update,
} from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { tickerLine, transcriptLines } from "../../src/chat/view.js";

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

const withEntries = (): ChatModel =>
  feed(createChat("mock-m", {}, []), [
    { type: "info", text: "alpha" },
    { type: "info", text: "beta" },
    { type: "info", text: "ALPHA" },
  ]);

describe("UX-49: /find — hits fixed at find time, n/N cycle, accent + ticker, scroll", () => {
  it("reducer: case-insensitive hits, at 0, transcript focus; n/N wrap; no-match info; clear", () => {
    let m = withEntries();
    m = update(m, { type: "submit", text: "/find alpha" }).model;
    expect(m.search).toEqual({ query: "alpha", hits: [0, 2], at: 0 });
    expect(m.focus).toBe("transcript");
    m = update(m, { type: "key", key: "n" }).model;
    expect(m.search?.at).toBe(1);
    // revert-check: drop the modulo → at reads 2, past the last hit.
    m = update(m, { type: "key", key: "n" }).model;
    expect(m.search?.at).toBe(0);
    m = update(m, { type: "key", key: "N" }).model;
    expect(m.search?.at).toBe(1);
    // a later entry is not re-scanned
    m = update(m, { type: "info", text: "alpha again" }).model;
    expect(m.search?.hits).toEqual([0, 2]);
    const none = update(m, { type: "submit", text: "/find zzz" });
    expect(none.model.search).toBeNull();
    expect(none.model.entries.at(-1)).toEqual({
      kind: "info",
      text: 'no matches for "zzz"',
    });
    const cleared = update(m, { type: "submit", text: "/find" });
    expect(cleared.model.search).toBeNull();
    expect(cleared.model.entries).toEqual(m.entries);
    // n/N are no-ops without a search or while input-focused
    expect(update(cleared.model, { type: "key", key: "n" }).model).toBe(
      cleared.model,
    );
    const inputFocused = { ...m, focus: "input" as const };
    expect(update(inputFocused, { type: "key", key: "n" }).model).toBe(
      inputFocused,
    );
  });

  it("view: the current hit's segments are all accent, others are not; ticker reads match k/n", () => {
    const m = update(withEntries(), {
      type: "submit",
      text: "/find alpha",
    }).model;
    const lines = transcriptLines(m);
    // revert-check: skip the accent mapping → the first line keeps dim/fg.
    expect(lines[0]?.every((s) => s.role === "accent")).toBe(true);
    expect(lines[1]?.some((s) => s.role !== "accent")).toBe(true);
    expect(tickerLine(m).right).toBe("match 1/2 · /help · esc");
    const cleared = update(m, { type: "submit", text: "/find" }).model;
    expect(tickerLine(cleared).right).toBe("/help · esc");
  });

  it("renderer: a hit early in a long transcript scrolls into view; clearing resumes tail-follow", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const surface = createSurface(setup.renderer, {});
    let m = createChat("mock-m", {}, []);
    const render = async (): Promise<void> => {
      surface.update(m);
      await setup.renderOnce();
    };
    for (let i = 0; i < 30; i++) {
      m = update(m, {
        type: "info",
        text: `row-${String(i).padStart(2, "0")}`,
      }).model;
      await render();
    }
    await render();
    expect(setup.captureCharFrame()).toContain("row-29");
    m = update(m, { type: "submit", text: "/find row-03" }).model;
    await render();
    await render(); // settle: the scroll lands one layout behind (UX-30 precedent)
    const found = setup.captureCharFrame();
    // revert-check: drop scrollToSearch → the viewport stays at the tail.
    expect(found).toContain("row-03");
    expect(found).not.toContain("row-29");
    m = update(m, { type: "submit", text: "/find" }).model;
    m = update(m, { type: "info", text: "row-30" }).model;
    await render();
    await render();
    expect(setup.captureCharFrame()).toContain("row-30");
    setup.renderer.destroy();
  });
});
