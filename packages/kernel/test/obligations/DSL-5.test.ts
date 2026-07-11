import { describe, expect, it } from "bun:test";
import {
  compileRateLimiter,
  loadRateLimiter,
  rateLimiterMarkdown,
} from "../obspec-helpers.ts";

describe("DSL-5: T1+ invariants require an existing formal model; every T1+ invariant registers a runtime probe", () => {
  it("a T1 fixture with a missing model file is rejected", () => {
    const res = compileRateLimiter(
      rateLimiterMarkdown().replace("tla/RateLimiter.tla", "tla/Missing.tla"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some(
          (e) =>
            e.clause_id === "RL-INV-1" && e.message.includes("Missing.tla"),
        ),
      ).toBe(true);
  });

  it("a T1 invariant with no model at all is rejected", () => {
    const res = compileRateLimiter(
      rateLimiterMarkdown().replace("model: tla/RateLimiter.tla\n", ""),
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.errors.some((e) => e.clause_id === "RL-INV-1")).toBe(true);
  });

  it("the probe registry contains one entry per T1+ invariant after compile", () => {
    const spec = loadRateLimiter();
    expect(spec.invariants.map((i) => i.id)).toEqual(["RL-INV-1"]);
    const probe = (spec.invariants[0] as (typeof spec.invariants)[0]).probe;
    expect(probe({ window_counts: new Map([["a", 2]]), limit: 5 })).toBe(true);
    expect(probe({ window_counts: new Map([["a", 9]]), limit: 5 })).toBe(false);
  });

  it.todo("a failing model check rejects the spec — TLC-in-CI lands with Phase 4", () => {});
});
