import { describe, expect, it } from "bun:test";
import {
  kvGrid,
  panel,
  sideBySideDiff,
  sparkline,
  table,
  toned,
} from "../../src/components/render.ts";
import { write } from "../../src/components/sink.ts";

const widths = (s: string): number[] => s.split("\n").map((l) => l.length);

describe("UX-4: TUI views render correctly at 80 columns, honor NO_COLOR, and degrade to plain text when not a TTY", () => {
  it("panel renders exactly at its width at 80 and 120 columns", () => {
    for (const w of [80, 120]) {
      const p = panel("title", "line one\nline two", w);
      for (const lw of widths(p)) expect(lw).toBe(w);
    }
  });

  it("table aligns columns and right-aligns numerics", () => {
    const t = table(
      [{ header: "id" }, { header: "cost", align: "right" }],
      [
        ["a", "$0.42"],
        ["longer-id", "$12.00"],
      ],
    );
    const lines = t.split("\n");
    expect(lines[0]).toBe("id           cost");
    expect(lines[2]).toBe("a           $0.42");
    expect(lines[3]).toBe("longer-id  $12.00");
  });

  it("kvGrid pads keys to a single column", () => {
    expect(
      kvGrid([
        ["k", "v"],
        ["key", "v2"],
      ]),
    ).toBe("k    v\nkey  v2");
  });

  it("sparkline maps min..max to the tick ramp; empty and flat inputs are total", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([5, 5, 5])).toBe("▁▁▁");
    const s = sparkline([0, 7]);
    expect(s).toBe("▁█");
  });

  it("diff marks differing lines and pads to two columns", () => {
    const d = sideBySideDiff("a\nb", "a\nc", 21);
    const lines = d.split("\n");
    expect(lines[0]).toContain(" │ ");
    expect(lines[1]).toContain("┃");
  });

  // Discriminating fixtures (F-100): exercise a renderer that actually
  // colors, on both sides of the NO_COLOR/TTY boundary — deleting the
  // NO_COLOR check or the sink's strip must fail these.
  it("paint colors on a TTY without NO_COLOR, and not otherwise", () => {
    const savedTty = process.stdout.isTTY;
    const savedNoColor = process.env.NO_COLOR;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      delete process.env.NO_COLOR;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI presence
      expect(toned("green", "✓", "ok")).toMatch(/\x1b\[32m.*\x1b\[0m/);
      process.env.NO_COLOR = "1";
      expect(toned("green", "✓", "ok")).toBe("✓ ok");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: savedTty,
        configurable: true,
      });
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  });

  it("sink strips ANSI when not a TTY (plain sequential fallback)", () => {
    const savedWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      write("\x1b[32m✓ ok\x1b[0m plain");
    } finally {
      process.stdout.write = savedWrite;
    }
    expect(chunks.join("")).toBe("✓ ok plain\n");
  });

  it("static renderers emit no ANSI under non-TTY defaults", () => {
    const all = [
      panel("t", "b"),
      table([{ header: "h" }], [["v"]]),
      kvGrid([["k", "v"]]),
      sparkline([1, 2]),
    ].join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI absence
    expect(all).not.toMatch(/\x1b\[/);
  });
});
