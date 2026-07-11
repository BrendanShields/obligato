import { describe, expect, it } from "bun:test";
import type { ObspecDomain } from "@obligato/schemas";
import fc from "fast-check";
import { domainArbitrary } from "../../src/generators.ts";
import { compileSpec } from "../../src/obspec.ts";

const D = (block: object): ObspecDomain => block as ObspecDomain;
const domains = new Map<string, ObspecDomain>([
  [
    "Rate",
    D({
      kind: "domain",
      type: "int",
      id: "Rate",
      unit: "rpm",
      min: 0,
      max: 100,
    }),
  ],
  [
    "Ratio",
    D({
      kind: "domain",
      type: "float",
      id: "Ratio",
      unit: "fraction",
      min: -1.5,
      max: 1.5,
    }),
  ],
  [
    "Code",
    D({
      kind: "domain",
      type: "string",
      id: "Code",
      pattern: "^[a-z]{2,4}$",
      max_length: 3,
    }),
  ],
  [
    "Color",
    D({ kind: "domain", type: "enum", id: "Color", values: ["red", "green"] }),
  ],
  [
    "Point",
    D({
      kind: "domain",
      type: "struct",
      id: "Point",
      fields: { x: "Rate", y: "Rate" },
    }),
  ],
  [
    "Rates",
    D({ kind: "domain", type: "list", id: "Rates", of: "Rate", max_items: 5 }),
  ],
  [
    "RateByCode",
    D({
      kind: "domain",
      type: "map",
      id: "RateByCode",
      keys: "Code",
      values: "Rate",
      max_items: 4,
    }),
  ],
]);

const N = 10_000;
const sample = (ref: string) => fc.sample(domainArbitrary(domains, ref), N);

describe("DSL-2: derived generators produce only values satisfying declared domain constraints", () => {
  it("int: 10,000 samples within bounds and integral", () => {
    for (const v of sample("Rate") as number[]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("float: 10,000 samples within bounds, never NaN", () => {
    for (const v of sample("Ratio") as number[]) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(-1.5);
      expect(v).toBeLessThanOrEqual(1.5);
    }
  });

  it("string: 10,000 samples match pattern and max_length", () => {
    const re = /^[a-z]{2,4}$/;
    for (const v of sample("Code") as string[]) {
      expect(re.test(v)).toBe(true);
      expect(v.length).toBeLessThanOrEqual(3);
    }
  });

  it("enum: 10,000 samples are declared values", () => {
    for (const v of sample("Color") as string[])
      expect(["red", "green"]).toContain(v);
  });

  it("struct/list/map: 10,000 samples satisfy nested constraints", () => {
    for (const v of sample("Point") as { x: number; y: number }[]) {
      expect(Number.isInteger(v.x) && v.x >= 0 && v.x <= 100).toBe(true);
      expect(Number.isInteger(v.y) && v.y >= 0 && v.y <= 100).toBe(true);
    }
    for (const v of sample("Rates") as number[][]) {
      expect(v.length).toBeLessThanOrEqual(5);
      for (const x of v)
        expect(Number.isInteger(x) && x >= 0 && x <= 100).toBe(true);
    }
    for (const v of sample("RateByCode") as Record<string, number>[]) {
      const entries = Object.entries(v);
      expect(entries.length).toBeLessThanOrEqual(4);
      for (const [k, x] of entries) {
        expect(/^[a-z]{2,4}$/.test(k) && k.length <= 3).toBe(true);
        expect(Number.isInteger(x) && x >= 0 && x <= 100).toBe(true);
      }
    }
  });

  it("a boundless numeric domain is rejected at compile", () => {
    const md = `\`\`\`obspec
kind: component
id: widget
tier: T0
authority: authored
events: [poked]
\`\`\`

\`\`\`obspec
kind: domain
id: Unbounded
type: int
unit: bytes
min: 0
\`\`\`
`;
    const res = compileSpec(md, { file: "boundless.spec.md" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.block_index === 1)).toBe(true);
  });

  it("a unitless numeric domain is rejected at compile", () => {
    const md = `\`\`\`obspec
kind: component
id: widget
tier: T0
authority: authored
events: [poked]
\`\`\`

\`\`\`obspec
kind: domain
id: NoUnit
type: int
min: 0
max: 10
\`\`\`
`;
    const res = compileSpec(md, { file: "unitless.spec.md" });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some((e) => e.path === "unit" && e.block_index === 1),
      ).toBe(true);
  });
});
