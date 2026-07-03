import { describe, expect, it } from "bun:test";
import {
  appendEvent,
  compactSession,
  currentHead,
  forkSession,
  listEvents,
  reconstruct,
  reconstructFrom,
} from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

const msg = (
  db: Parameters<typeof appendEvent>[0],
  sid: string,
  parent: string | null,
  text: string,
) =>
  appendEvent(db, {
    session_id: sid,
    parent_id: parent,
    kind: "user_message",
    payload: { text },
  });

describe("SES-8: compaction substitutes a summary without deleting originals", () => {
  it("reconstruct replaces the covered span with one summary; originals remain in the store", () => {
    const f = fixture([]);
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-1",
    );
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-2",
    );
    const beforeCount = listEvents(f.db, f.sessionId).length;

    const range = compactSession(
      f.db,
      f.sessionId,
      () => "SUMMARY of the chat",
    );

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const texts = chain
      .filter((e) => e.payload.text)
      .map((e) => e.payload.text);
    // The whole covered prefix collapses to the single summary message.
    expect(texts).toEqual(["SUMMARY of the chat"]);
    expect(chain[0]?.payload.compacted).toBe(true);
    // Nothing deleted — the originals (plus the new compaction event) remain.
    expect(listEvents(f.db, f.sessionId).length).toBeGreaterThan(beforeCount);
    // The covered range ends at the pre-compaction head (turn-2), not the new
    // compaction marker that is now current.
    const turn2 = listEvents(f.db, f.sessionId).find(
      (e) => e.payload.text === "turn-2",
    );
    expect(range.to_event).toBe(turn2?.id as string);
  });

  it("a fork before the compaction reconstructs the full original history (no summary)", () => {
    const f = fixture([]);
    const preCompact = msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-1",
    );
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-2",
    );
    compactSession(f.db, f.sessionId, () => "SUMMARY");

    // Fork at an event BEFORE the compaction → full history, no summary.
    const { forkHead } = forkSession(f.db, f.sessionId, preCompact.id);
    const forkChain = reconstructFrom(listEvents(f.db, f.sessionId), forkHead);
    const texts = forkChain
      .filter((e) => e.payload.text)
      .map((e) => e.payload.text);
    expect(texts).toContain("turn-1");
    expect(texts).not.toContain("SUMMARY"); // compaction is on the other branch
  });
});
