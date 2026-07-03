import { describe, expect, it } from "bun:test";
import {
  appendEvent,
  currentHead,
  forkSession,
  listEvents,
  reconstructFrom,
} from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

const textIds = (evs: { payload: Record<string, unknown> }[]) =>
  evs.filter((e) => e.payload.text).map((e) => e.payload.text);

describe("SES-6: fork branches at an event, isolating the branches", () => {
  it("fork at an interior event excludes the original branch's later events; both heads derive", () => {
    const f = fixture([]);
    // Chain: root, "do the thing"(from fixture), then A, B on the main branch.
    const a = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: currentHead(listEvents(f.db, f.sessionId)),
      kind: "user_message",
      payload: { text: "A" },
    });
    appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: a.id,
      kind: "user_message",
      payload: { text: "B" },
    });

    // Fork at A → the fork must not see B.
    const { forkHead, originalHead } = forkSession(f.db, f.sessionId, a.id);
    const events = listEvents(f.db, f.sessionId);
    const forkChain = reconstructFrom(events, forkHead);
    const origChain = reconstructFrom(events, originalHead);

    expect(textIds(forkChain)).toContain("A");
    expect(textIds(forkChain)).not.toContain("B"); // other-branch event absent
    expect(textIds(origChain)).toEqual(["do the thing", "A", "B"]);
    // Both heads simultaneously derivable.
    expect(forkChain.length).toBeGreaterThan(0);
    expect(origChain.length).toBeGreaterThan(0);
    // The fork became the current head (SES-3).
    expect(currentHead(events)).toBe(forkHead);
  });

  it("a new event after a fork attaches to the fork, leaving the original branch untouched", () => {
    const f = fixture([]);
    const a = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: currentHead(listEvents(f.db, f.sessionId)),
      kind: "user_message",
      payload: { text: "A" },
    });
    const { originalHead } = forkSession(f.db, f.sessionId, a.id);
    // Append on the (now-current) fork branch.
    appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: currentHead(listEvents(f.db, f.sessionId)),
      kind: "user_message",
      payload: { text: "C" },
    });
    const events = listEvents(f.db, f.sessionId);
    expect(textIds(reconstructFrom(events, currentHead(events)))).toContain(
      "C",
    );
    // The original branch never sees C.
    expect(textIds(reconstructFrom(events, originalHead))).not.toContain("C");
  });

  it("fork at a non-existent event id errors and appends nothing", () => {
    const f = fixture([]);
    const before = listEvents(f.db, f.sessionId).length;
    expect(() => forkSession(f.db, f.sessionId, "01NONEXISTENT")).toThrow(
      /no event/,
    );
    expect(listEvents(f.db, f.sessionId).length).toBe(before);
  });
});
