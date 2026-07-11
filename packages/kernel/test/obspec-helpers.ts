import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompiledSpec, compileSpec } from "../src/obspec.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const RATE_LIMITER_FILE = "docs/obspec/rate-limiter.spec.md";

export const rateLimiterMarkdown = (): string =>
  readFileSync(join(FIXTURES, "DSL", "rate-limiter.spec.md"), "utf8");

export const compileRateLimiter = (markdown = rateLimiterMarkdown()) => {
  const res = compileSpec(markdown, {
    file: RATE_LIMITER_FILE,
    rootDir: join(FIXTURES, "DSL"),
  });
  return res;
};

export const loadRateLimiter = (): CompiledSpec => {
  const res = compileRateLimiter();
  if (!res.ok || res.spec === null)
    throw new Error(
      `rate-limiter fixture failed to compile: ${JSON.stringify(res.ok ? null : res.errors)}`,
    );
  return res.spec;
};

const WINDOW_REMAINDER = 30;

export const correctLimiterHarness = (
  inputs: Record<string, unknown>,
): Record<string, unknown> => {
  const { rate, count } = inputs as { rate: number; count: number };
  const limited = count >= rate;
  return {
    response: limited
      ? { status: 429, retry_after: WINDOW_REMAINDER }
      : { status: 200, retry_after: null },
    window_remainder: WINDOW_REMAINDER,
  };
};

// Violates RL-1: rejects with a retry_after that is not the window remainder.
export const mutatedLimiterHarness = (
  inputs: Record<string, unknown>,
): Record<string, unknown> => {
  const { rate, count } = inputs as { rate: number; count: number };
  const limited = count >= rate;
  return {
    response: limited
      ? { status: 429, retry_after: WINDOW_REMAINDER + 1 }
      : { status: 200, retry_after: null },
    window_remainder: WINDOW_REMAINDER,
  };
};
