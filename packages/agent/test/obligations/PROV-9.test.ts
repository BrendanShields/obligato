import { describe, expect, it } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { runTurn, step } from "../../src/loop.ts";
import { fixture, textResponse } from "../helpers.ts";

const transientError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`transient ${status}`), {
    statusCode: status,
    isRetryable: status !== 400,
    responseHeaders: headers,
  });

// A model whose doStream throws for the first `failures` calls, then streams
// the given chunks. Counts invocations.
const failingModel = (
  failures: number,
  err: (attempt: number) => Error,
  chunks: unknown[],
): { model: MockLanguageModelV4; calls: () => number } => {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n++;
      if (n <= failures) throw err(n);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: scripted fixture chunks
        stream: simulateReadableStream({ chunks: chunks as any[] }),
      };
    },
  });
  return { model, calls: () => n };
};

const sleeper = (): {
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
} => {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
};

describe("PROV-9: bounded transport retry with injectable backoff", () => {
  it("503 twice then success: one assistant event, 3 invocations, seeded-jitter sleeps", async () => {
    const f = fixture([]);
    const { model, calls } = failingModel(
      2,
      () => transientError(503),
      textResponse("recovered"),
    );
    const s = sleeper();
    const result = await runTurn({
      ...f.deps,
      model,
      // random() = 1 → jitter multiplier exactly 1 → base * 2^attempt.
      retry: { baseDelayMs: 100, sleep: s.sleep, random: () => 1 },
    });
    expect(result.status).toBe("done");
    if (result.status === "done") expect(result.text).toBe("recovered");
    expect(calls()).toBe(3);
    // Hand-computed: attempt 0 → 100 * 2^0 * (0.5 + 1/2) = 100;
    // attempt 1 → 100 * 2^1 * 1 = 200.
    expect(s.sleeps).toEqual([100, 200]);
    const assistants = f.db
      .query(
        "SELECT COUNT(*) AS n FROM session_event WHERE session_id = ? AND kind = 'assistant_message'",
      )
      .get(f.sessionId) as { n: number };
    expect(assistants.n).toBe(1);
  });

  it("a numeric retry-after header is honored exactly", async () => {
    const f = fixture([]);
    const { model, calls } = failingModel(
      1,
      () => transientError(429, { "retry-after": "7" }),
      textResponse("ok"),
    );
    const s = sleeper();
    const result = await runTurn({
      ...f.deps,
      model,
      retry: { baseDelayMs: 100, sleep: s.sleep, random: () => 1 },
    });
    expect(result.status).toBe("done");
    expect(calls()).toBe(2);
    expect(s.sleeps).toEqual([7000]);
  });

  it("a 400 fails without retry: one invocation, no sleep", async () => {
    const f = fixture([]);
    const { model, calls } = failingModel(
      99,
      () => transientError(400),
      textResponse("never"),
    );
    const s = sleeper();
    await expect(
      runTurn({ ...f.deps, model, retry: { sleep: s.sleep } }),
    ).rejects.toThrow("transient 400");
    expect(calls()).toBe(1);
    expect(s.sleeps).toEqual([]);
  });

  it("a failure after a streamed delta fails without retry", async () => {
    const f = fixture([]);
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "partial" },
              { type: "error", error: transientError(503) },
              // biome-ignore lint/suspicious/noExplicitAny: scripted fixture chunks
            ] as any[],
          }),
        };
      },
    });
    const s = sleeper();
    await expect(
      runTurn({ ...f.deps, model, retry: { sleep: s.sleep } }),
    ).rejects.toThrow("transient 503");
    expect(n).toBe(1);
    expect(s.sleeps).toEqual([]);
    // the failed attempt appended nothing
    const assistants = f.db
      .query(
        "SELECT COUNT(*) AS n FROM session_event WHERE session_id = ? AND kind = 'assistant_message'",
      )
      .get(f.sessionId) as { n: number };
    expect(assistants.n).toBe(0);
  });

  it("a subscription 401 still names claude setup-token with exactly one request", async () => {
    const f = fixture([]);
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++;
        throw Object.assign(new Error("token expired"), {
          statusCode: 401,
          isRetryable: false,
        });
      },
    });
    await expect(
      step({ ...f.deps, model, authKind: "subscription" }),
    ).rejects.toThrow(/claude setup-token/);
    expect(n).toBe(1);
  });
});
