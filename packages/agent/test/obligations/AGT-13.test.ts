import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, CORE_TOOLS, localExec } from "../../src/tools.ts";

const edit = CORE_TOOLS.find((t) => t.name === "edit") as AgentTool;

const workspace = (content: string): { dir: string; file: string } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-edit-")));
  const file = join(dir, "f.ts");
  writeFileSync(file, content);
  return { dir, file };
};

const run = (dir: string, input: Record<string, unknown>): string =>
  edit.run({ path: "f.ts", ...input }, { cwd: dir, exec: localExec(dir) });

describe("AGT-13: tolerant edit layers — exact first, then trailing-WS, then uniform indent shift", () => {
  it("an exact match still replaces byte-identically", () => {
    const w = workspace("const a = 1;\nconst b = 2;\n");
    run(w.dir, { old: "const b = 2;", new: "const b = 3;" });
    expect(readFileSync(w.file, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("trailing-whitespace drift succeeds via layer (a), rest of file untouched", () => {
    // file lines carry trailing spaces the model's quote lacks
    const w = workspace("keep\nfoo(1);  \nbar(2);\t\nkeep2\n");
    const out = run(w.dir, {
      old: "foo(1);\nbar(2);",
      new: "foo(9);\nbar(9);",
    });
    expect(out).toContain("trailing-whitespace-insensitive");
    expect(readFileSync(w.file, "utf8")).toBe(
      "keep\nfoo(9);\nbar(9);\nkeep2\n",
    );
  });

  it("a tabs-vs-spaces substitution succeeds via layer (b) with the FILE's leading re-applied", () => {
    // file indents with two tabs; the model quoted four spaces
    const w = workspace("if (x) {\n\t\tdoIt();\n\t\tmore();\n}\n");
    const out = run(w.dir, {
      old: "    doIt();\n    more();",
      new: "    doIt(1);\n    more(2);",
    });
    expect(out).toContain("consistent-indentation-remap");
    // byte-exact: replacement carries the file's two-tab leading, not spaces
    expect(readFileSync(w.file, "utf8")).toBe(
      "if (x) {\n\t\tdoIt(1);\n\t\tmore(2);\n}\n",
    );
  });

  it("identical old leadings meeting different file leadings are refused (inconsistent map)", () => {
    // both old lines share the same leading, but the file diverges: the map
    // would need "  " → "  " AND "  " → "      " — not a function.
    const w = workspace("  a();\n      b();\n");
    expect(() => run(w.dir, { old: "  a();\n  b();", new: "x" })).toThrow(
      /not found/,
    );
  });

  it("two tolerant windows without all are refused naming the count", () => {
    const w = workspace("x();  \ny();\nx();  \ny();\n");
    expect(() => run(w.dir, { old: "x();\ny();", new: "z();\ny();" })).toThrow(
      /matches 2 windows/,
    );
  });

  it("all=true replaces both tolerant windows", () => {
    const w = workspace("x();  \ny();\nmid\nx();  \ny();\n");
    const out = run(w.dir, {
      old: "x();\ny();",
      new: "z();\ny();",
      all: true,
    });
    expect(out).toContain("replaced 2");
    expect(readFileSync(w.file, "utf8")).toBe("z();\ny();\nmid\nz();\ny();\n");
  });

  it("all=true with a length-changing replacement keeps both windows intact (splice ordering)", () => {
    // new (3 lines) is longer than old (2): front-to-back splicing would
    // shift the second window's start and corrupt it (F-100 discriminating
    // fixture for the back-to-front rule).
    const w = workspace("x();  \ny();\nmid\nx();  \ny();\n");
    const out = run(w.dir, {
      old: "x();\ny();",
      new: "a();\nb();\nc();",
      all: true,
    });
    expect(out).toContain("replaced 2");
    expect(readFileSync(w.file, "utf8")).toBe(
      "a();\nb();\nc();\nmid\na();\nb();\nc();\n",
    );
  });

  it("a total miss's error carries the near-miss excerpt", () => {
    const w = workspace("alpha\nfoo(1);\nbeta\n");
    expect(() => run(w.dir, { old: "foo(1);\nnope();", new: "x" })).toThrow(
      /closest match near line 2[\s\S]*foo\(1\);/,
    );
  });
});
