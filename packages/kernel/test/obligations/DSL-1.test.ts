import { describe, expect, it } from "bun:test";
import { compileSpec } from "../../src/obspec.ts";

const COMPONENT = `\`\`\`obspec
kind: component
id: widget
tier: T0
authority: authored
events: [poked]
\`\`\``;

const spec = (block: string) =>
  `# doc\n\n${COMPONENT}\n\n\`\`\`obspec\n${block}\`\`\`\n`;

describe("DSL-1: fenced obspec blocks are the sole clause source; schema failures name file, block index, and field path", () => {
  it("prose-only files parse as empty specs without error", () => {
    const res = compileSpec("# Only prose here.\n\nNo fenced blocks.\n", {
      file: "prose.spec.md",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec).toBeNull();
  });

  it("a bad enum names the exact field path", () => {
    const res = compileSpec(
      spec("kind: component\nid: other\ntier: T5\nauthority: authored\n"),
      { file: "bad-enum.spec.md" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hit = res.errors.find((e) => e.path === "tier");
      expect(hit).toBeDefined();
      expect(hit?.file).toBe("bad-enum.spec.md");
      expect(hit?.block_index).toBe(1);
    }
  });

  it("a missing required field names the exact field path", () => {
    const res = compileSpec(
      spec(
        "kind: clause\nid: WID-1\nears: ubiquitous\ncheck: '(ctx) => true'\n",
      ),
      { file: "missing-field.spec.md" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some((e) => e.path === "text" && e.block_index === 1),
      ).toBe(true);
  });

  it("a wrong-typed field names the exact field path", () => {
    const res = compileSpec(
      spec(
        "kind: domain\nid: Size\ntype: int\nunit: bytes\nmin: zero\nmax: 10\n",
      ),
      { file: "wrong-type.spec.md" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some((e) => e.path === "min" && e.block_index === 1),
      ).toBe(true);
  });

  it("an unknown block kind is a block-level error", () => {
    const res = compileSpec(spec("kind: widget\nid: nope\n"), {
      file: "bad-kind.spec.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.block_index === 1)).toBe(true);
  });

  it("invalid YAML reports the block index", () => {
    const res = compileSpec(spec("kind: clause\nid: [unclosed\n"), {
      file: "bad-yaml.spec.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some(
          (e) => e.block_index === 1 && e.message.includes("YAML"),
        ),
      ).toBe(true);
  });
});
