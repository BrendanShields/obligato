import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSpec } from "../../src/obspec.ts";
import { FIXTURES } from "../obspec-helpers.ts";

describe("SPEC-3: an oracle-free clause needs a signed unverifiable annotation; the unverifiable ratio is reported per spec", () => {
  it("an unannotated uncompilable clause blocks the spec", () => {
    const md = readFileSync(
      join(FIXTURES, "SPEC-1", "vague", "fast.spec.md"),
      "utf8",
    );
    const res = compileSpec(md, { file: "fast.spec.md" });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.errors.some((e) => e.clause_id === "SRCH-1")).toBe(true);
  });

  it("an annotated clause passes but increments the reported ratio", () => {
    const md = readFileSync(
      join(FIXTURES, "SPEC-1", "wellformed", "greeter.spec.md"),
      "utf8",
    );
    const res = compileSpec(md, { file: "greeter.spec.md" });
    expect(res.ok).toBe(true);
    if (res.ok && res.spec !== null) {
      // GRT-2 of {GRT-1, GRT-2} is signed unverifiable.
      expect(res.spec.manifest.unverifiable_ratio).toBe(0.5);
      const grt2 = res.spec.clauses.find((c) => c.id === "GRT-2");
      expect(grt2?.unverifiable).toBe(true);
      expect(grt2?.makeProperty).toBeNull();
    }
  });

  it("a fully-checked spec reports ratio 0", () => {
    const md = readFileSync(
      join(FIXTURES, "SPEC-1", "wellformed", "counter.spec.md"),
      "utf8",
    );
    const res = compileSpec(md, { file: "counter.spec.md" });
    expect(res.ok).toBe(true);
    if (res.ok && res.spec !== null)
      expect(res.spec.manifest.unverifiable_ratio).toBe(0);
  });
});
