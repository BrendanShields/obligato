import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import {
  appendEvent,
  currentHead,
  listEvents,
  reconstruct,
} from "../../src/sessions.ts";
import { fixture, textResponse, USAGE_FIXTURE } from "../helpers.ts";

// Two deltas so the abort raised from the first one is observed by the SDK's
// pull before the stream finishes (ai 7.0.14 emits an `abort` part and closes).
const twoDeltas = (a: string, b: string): unknown[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: a },
  { type: "text-delta", id: "t1", delta: b },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop", usage: USAGE_FIXTURE },
];

const stepCount = (db: { query: (q: string) => { get: () => unknown } }) =>
  (db.query("SELECT COUNT(*) AS n FROM step_event").get() as { n: number }).n;

describe("UX-44 (loop arm): an aborted step appends nothing; a resend carries both user messages", () => {
  it("abort from onDelta → runTurn rejects, chain ends at the user_message, step_event count unchanged", async () => {
    const f = fixture([twoDeltas("hel", "lo"), textResponse("done")]);
    const controller = new AbortController();
    const deltas: string[] = [];
    const before = stepCount(f.db);
    await expect(
      runTurn({
        ...f.deps,
        abort: controller.signal,
        onDelta: (t) => {
          deltas.push(t);
          controller.abort();
        },
      }),
    ).rejects.toThrow("step aborted");
    expect(deltas[0]).toBe("hel");
    const chain = reconstruct(listEvents(f.db, f.sessionId));
    // revert-check: drop the `abort` part branch in loop.ts → the stream
    // falls through to the append and an assistant_message lands here.
    expect(chain.at(-1)?.kind).toBe("user_message");
    expect(chain.some((e) => e.kind === "assistant_message")).toBe(false);
    expect(stepCount(f.db)).toBe(before);

    // Resend: two consecutive user messages reach the next model call.
    appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: currentHead(listEvents(f.db, f.sessionId)),
      kind: "user_message",
      payload: { text: "again" },
    });
    const r = await runTurn(f.deps);
    expect(r.status).toBe("done");
    const prompt = f.model.doStreamCalls[1]?.prompt as { role: string }[];
    expect(prompt.filter((m) => m.role === "user")).toHaveLength(2);
    const after = reconstruct(listEvents(f.db, f.sessionId));
    expect(after.filter((e) => e.kind === "user_message")).toHaveLength(2);
    expect(after.at(-1)?.kind).toBe("assistant_message");
  });
});
