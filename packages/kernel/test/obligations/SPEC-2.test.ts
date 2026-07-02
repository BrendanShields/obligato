import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { domainArbitrary } from "../../src/generators.ts";
import { correctLimiterHarness, loadRateLimiter } from "../kelspec-helpers.ts";

describe("SPEC-2: obligations run against the spec's declared input domains, not ad-hoc examples", () => {
  it("generators derived from the compiled spec's domains produce only in-domain values", () => {
    const spec = loadRateLimiter();
    for (const id of ["RequestRate", "WindowCount"]) {
      for (const v of fc.sample(
        domainArbitrary(spec.domains, id),
        10_000,
      ) as number[]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100000);
      }
    }
  });

  it("a compiled clause property draws its inputs from the declared domains", () => {
    const spec = loadRateLimiter();
    const rl1 = spec.clauses.find((c) => c.id === "RL-1");
    if (!rl1?.makeProperty)
      throw new Error("RL-1 did not compile to a property");
    const seen: Record<string, unknown>[] = [];
    const prop = rl1.makeProperty((inputs) => {
      seen.push(inputs);
      return correctLimiterHarness(inputs);
    });
    fc.assert(prop, { numRuns: 250 });
    expect(seen.length).toBeGreaterThan(0);
    for (const inputs of seen) {
      const { rate, count } = inputs as { rate: number; count: number };
      expect(Number.isInteger(rate) && rate >= 0 && rate <= 100000).toBe(true);
      expect(Number.isInteger(count) && count >= 0 && count <= 100000).toBe(
        true,
      );
    }
  });
});
