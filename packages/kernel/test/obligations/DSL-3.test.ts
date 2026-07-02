import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { analyzeCheck } from "../../src/predicate.ts";
import {
  correctLimiterHarness,
  loadRateLimiter,
  mutatedLimiterHarness,
} from "../kelspec-helpers.ts";

const decl = {
  inputs: ["rate", "count"],
  observe: ["response.status", "response.retry_after"],
};

describe("DSL-3: check compiles to a property over declared inputs/observables; out-of-scope references are compile errors naming the variable", () => {
  it("a global reference is rejected by name", () => {
    const errors = analyzeCheck(
      "(ctx) => ctx.expect(Math.abs(ctx.rate) === ctx.rate)",
      decl,
    );
    expect(errors.some((e) => e.includes('"Math"'))).toBe(true);
  });

  it("a locally-declared variable is exempt", () => {
    expect(
      analyzeCheck(
        "(ctx) => { const limit = ctx.rate * 2; return ctx.expect(ctx.response.status < limit); }",
        decl,
      ),
    ).toEqual([]);
  });

  it("a bare prefix of a declared dotted path is rejected", () => {
    const errors = analyzeCheck(
      "(ctx) => ctx.expect(ctx.response !== null)",
      decl,
    );
    expect(
      errors.some((e) => e.includes('"response"') && e.includes("prefix")),
    ).toBe(true);
  });

  it("access deeper than a declared leaf is allowed", () => {
    expect(
      analyzeCheck(
        "(ctx) => ctx.expect(ctx.response.status.toString().length > 0)",
        decl,
      ),
    ).toEqual([]);
  });

  it("when/expect are the closed helper set; other context methods are rejected", () => {
    expect(
      analyzeCheck(
        "(ctx) => ctx.when(ctx.count === ctx.rate).expect(ctx.response.status === 429)",
        decl,
      ),
    ).toEqual([]);
    const errors = analyzeCheck(
      "(ctx) => ctx.eventually(ctx.response.status === 200)",
      decl,
    );
    expect(errors.some((e) => e.includes('"eventually"'))).toBe(true);
  });

  it("empty observe is legal; reads are limited to inputs", () => {
    expect(
      analyzeCheck("(ctx) => ctx.expect(ctx.count <= ctx.rate)", {
        inputs: ["rate", "count"],
        observe: [],
      }),
    ).toEqual([]);
    const errors = analyzeCheck(
      "(ctx) => ctx.expect(ctx.window_counts.length >= 0)",
      {
        inputs: ["rate"],
        observe: [],
      },
    );
    expect(errors.some((e) => e.includes("window_counts"))).toBe(true);
  });

  it("a shadowed inner parameter silences declaration checking in its scope", () => {
    expect(
      analyzeCheck(
        "(ctx) => ctx.expect(ctx.response.status.parts.every((ctx) => ctx >= 0))",
        decl,
      ),
    ).toEqual([]);
  });

  it("compiled fixture executes under bun test and fails when the implementation is mutated", () => {
    const spec = loadRateLimiter();
    const rl1 = spec.clauses.find((c) => c.id === "RL-1");
    if (!rl1?.makeProperty)
      throw new Error("RL-1 did not compile to a property");
    const make = rl1.makeProperty;

    // The triggering boundary (count === rate) is vanishingly rare under
    // random pairs; pin it as an explicit example so falsification is
    // deterministic, not seed-dependent (postmortem F-039 rule).
    const examples = [[{ rate: 7, count: 7 }]] as [
      { rate: number; count: number },
    ][];
    fc.assert(make(correctLimiterHarness), { numRuns: 300, examples });
    const mutated = fc.check(make(mutatedLimiterHarness), {
      numRuns: 300,
      examples,
    });
    expect(mutated.failed).toBe(true);
  });
});
