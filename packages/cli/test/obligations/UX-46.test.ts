import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExport } from "../../src/chat/app.js";
import {
  type ChatModel,
  type ChatMsg,
  createChat,
  update,
} from "../../src/chat/model.js";
import { costText, transcriptMarkdown } from "../../src/chat/view.js";

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

const fixtureModel = (): ChatModel =>
  feed(
    createChat(
      "mock-m",
      { authKind: "subscription", repoName: "agent-harness", sessionId: "S1" },
      [],
    ),
    [
      { type: "submit", text: "fix the bug" },
      { type: "delta", text: "looking" },
      { type: "tool_result", name: "read", ok: true, output: "l1\nl2" },
      { type: "step_cost", costMicroUsd: 548 },
      { type: "error", message: "boom happened" },
    ],
  );

describe("UX-46: /export — effect, markdown projection, written file", () => {
  it("reducer: /export emits the export effect with null or the given path and appends nothing", () => {
    const m = createChat("mock-m", {}, []);
    const bare = update(m, { type: "submit", text: "/export" });
    expect(bare.effects).toEqual([{ type: "export", path: null }]);
    expect(bare.model.entries).toEqual(m.entries);
    // revert-check: treat /export as an unknown slash → error entry + menu.
    const pathed = update(m, { type: "submit", text: "/export out.md" });
    expect(pathed.effects).toEqual([{ type: "export", path: "out.md" }]);
    expect(pathed.model.entries).toEqual(m.entries);
  });

  it("transcriptMarkdown carries model, repo, cost, user text, fenced tool output, error headline", () => {
    const m = fixtureModel();
    const md = transcriptMarkdown(m);
    expect(md).toContain("# obligato chat — S1");
    expect(md).toContain("model: mock-m");
    expect(md).toContain("repo: agent-harness");
    expect(md).toContain(
      `cost: ${costText({ authKind: "subscription", costMicroUsd: 548, costUnknown: false })}`,
    );
    expect(md).toContain("**you:** fix the bug");
    expect(md).toContain("`read` ✓\n```\nl1\nl2\n```");
    expect(md).toContain("**error:** boom happened");
  });

  it("writeExport writes the markdown byte-equal, creating a missing parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "obligato-export-"));
    const path = join(dir, "nested", "deeper", "out.md");
    expect(existsSync(join(dir, "nested"))).toBe(false);
    const m = fixtureModel();
    const written = writeExport(m, path);
    // revert-check: drop the mkdir → writeFileSync throws ENOENT here.
    expect(readFileSync(written, "utf8")).toBe(transcriptMarkdown(m));
  });
});
