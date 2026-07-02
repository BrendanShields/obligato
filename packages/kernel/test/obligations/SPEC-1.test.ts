import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSpec } from "../../src/kelspec.ts";
import { FIXTURES } from "../kelspec-helpers.ts";

const corpus = (dir: string) =>
  readdirSync(join(FIXTURES, "SPEC-1", dir)).map((f) => ({
    file: f,
    result: compileSpec(
      readFileSync(join(FIXTURES, "SPEC-1", dir, f), "utf8"),
      {
        file: f,
      },
    ),
  }));

describe("SPEC-1: every requirement compiles to an executable obligation or the spec is rejected with clause-level diagnostics", () => {
  it("the vague corpus is 100% rejected, each with clause-level diagnostics", () => {
    for (const { file, result } of corpus("vague")) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some((e) => e.clause_id !== null),
          `${file} must carry a clause-level diagnostic`,
        ).toBe(true);
    }
  });

  it("vague diagnostics name the offending clause", () => {
    const byFile = new Map(corpus("vague").map((c) => [c.file, c.result]));
    const clauseIds = (file: string) => {
      const res = byFile.get(file);
      return res && !res.ok ? res.errors.map((e) => e.clause_id) : [];
    };
    expect(clauseIds("fast.spec.md")).toContain("SRCH-1");
    expect(clauseIds("graceful.spec.md")).toContain("IMP-1");
    expect(clauseIds("graceful.spec.md")).toContain("IMP-2");
    const scopeLeak = byFile.get("scope-leak.spec.md");
    expect(scopeLeak?.ok).toBe(false);
    if (scopeLeak && !scopeLeak.ok)
      expect(
        scopeLeak.errors.some(
          (e) => e.clause_id === "QTA-1" && e.message.includes("globalLimit"),
        ),
      ).toBe(true);
  });

  it("the well-formed corpus compiles 100%", () => {
    for (const { file, result } of corpus("wellformed")) {
      expect(result.ok, `${file} must compile`).toBe(true);
      if (result.ok) expect(result.spec).not.toBeNull();
    }
  });
});
