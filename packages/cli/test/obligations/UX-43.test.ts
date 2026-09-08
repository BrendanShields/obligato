import { describe, expect, it } from "bun:test";
import type { InboxItem } from "@obligato/schemas";
import { SelectRenderableEvents } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { COMMANDS } from "../../src/index.ts";
import { ALL_COMMANDS_ROW, buildLauncher } from "../../src/launcher.ts";
import {
  answerField,
  complete,
  createModel,
  type LauncherModel,
  openMenu,
  selectItem,
  verbSpec,
} from "../../src/wizards.ts";

const ID = "01JZWX13000000000000000000";
const ITEMS: InboxItem[] = [
  {
    kind: "proposal_review",
    id: ID,
    summary: "gated proposal for pack-a: enable pack-a",
    age_seconds: 120,
    verb: `obligato loop review ${ID}`,
    count: null,
  },
  {
    kind: "quarantined",
    id: "flaky-1",
    summary: "flaky-1 quarantined as flaky in seed@1.0.0",
    age_seconds: null,
    verb: "obligato eval suite promote flaky-1 --suite <suite-dir>",
    count: null,
  },
];

describe("UX-43: launcher home — inbox rows dispatch through the shared wizard path; empty inbox is the menu", () => {
  it("a placeholder-free verb completes through the patched COMMANDS entry with the verb's words", async () => {
    const calls: string[][] = [];
    const original = COMMANDS.loop;
    COMMANDS.loop = (argv) => {
      calls.push(argv);
    };
    try {
      let m = createModel(ITEMS);
      expect(m.state).toBe("home");
      m = selectItem(m, ITEMS[0] as InboxItem);
      expect(m.state).toBe("done");
      await complete(m, COMMANDS);
      // revert-check: keep the leading `obligato` in verbSpec → the dispatch
      // key is "obligato" (no entry) and complete throws instead.
      expect(calls).toEqual([["review", ID]]);
    } finally {
      COMMANDS.loop = original as (typeof COMMANDS)["loop"];
    }
  });

  it("a <placeholder> verb becomes a required field bound to its --flag, answered before dispatch", async () => {
    const calls: string[][] = [];
    const original = COMMANDS.eval;
    COMMANDS.eval = (argv) => {
      calls.push(argv);
    };
    try {
      const spec = verbSpec(ITEMS[1] as InboxItem);
      expect(spec.command).toBe("eval");
      expect(spec.subcommand).toEqual(["suite", "promote", "flaky-1"]);
      expect(spec.fields).toEqual([
        { key: "suite-dir", label: "suite-dir", required: true, flag: "suite" },
      ]);
      let m = selectItem(createModel(ITEMS), ITEMS[1] as InboxItem);
      expect(m.state).toBe("fields");
      m = answerField(m, "suites/seed");
      expect(m.state).toBe("done");
      await complete(m, COMMANDS);
      // revert-check: stop consuming the preceding --flag word → argv carries
      // a bare "--suite" before the field's own "--suite" and this fails.
      expect(calls).toEqual([
        ["suite", "promote", "flaky-1", "--suite", "suites/seed"],
      ]);
    } finally {
      COMMANDS.eval = original as (typeof COMMANDS)["eval"];
    }
  });

  it("all commands… opens the menu; zero items starts in the menu with the pre-home shape", () => {
    expect(openMenu(createModel(ITEMS)).state).toBe("menu");
    const empty: LauncherModel = createModel([]);
    // revert-check: start every model in "home" → state is "home" here.
    expect(empty).toEqual({
      state: "menu",
      spec: null,
      fieldIndex: 0,
      answers: {},
      inbox: [],
    });
  });

  it("renderer: the home frame lists every summary plus the menu row; selecting a row finishes with that verb's spec", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(
      { width: 80, height: 24 },
    );
    const finished: LauncherModel[] = [];
    buildLauncher(renderer, (m) => finished.push(m), ITEMS);
    await renderOnce();
    const frame = captureCharFrame();
    for (const i of ITEMS) expect(frame).toContain(i.summary.slice(0, 40));
    expect(frame).toContain(ALL_COMMANDS_ROW);
    expect(frame).toContain("2 items need you");
    const home = renderer.root.getRenderable("home") as unknown as {
      emit: (ev: string, i: number, opt: { value: InboxItem | null }) => void;
    };
    home.emit(SelectRenderableEvents.ITEM_SELECTED, 0, {
      value: ITEMS[0] as InboxItem,
    });
    // revert-check: route row selection through selectSpec(WIZARDS[i]) →
    // the finished spec is the init wizard, not the verb's.
    expect(finished).toHaveLength(1);
    expect(finished[0]?.state).toBe("done");
    expect(finished[0]?.spec).toEqual(verbSpec(ITEMS[0] as InboxItem));
    renderer.destroy();
  });
});
