import { describe, expect, it } from "bun:test";
import {
  appendEvent,
  compareBranches,
  currentHead,
  forkSession,
  listEvents,
} from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

const assistant = (
  db: Parameters<typeof appendEvent>[0],
  sid: string,
  parent: string | null,
  text: string,
  cost: number,
) =>
  appendEvent(db, {
    session_id: sid,
    parent_id: parent,
    kind: "assistant_message",
    payload: { text, tool_calls: [], cost_micro_usd: cost },
  });

describe("SES-7: compare two branches — cost, outcome, common ancestor", () => {
  it("reports the common ancestor, each branch's summed cost, and last text", () => {
    const f = fixture([]);
    const seam = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: currentHead(listEvents(f.db, f.sessionId)),
      kind: "user_message",
      payload: { text: "seam" },
    });
    // Branch A (cheap): one assistant at 100.
    assistant(f.db, f.sessionId, seam.id, "cheap answer", 100);
    const headA = currentHead(listEvents(f.db, f.sessionId));

    // Fork at the seam → branch B (expensive): two assistants totaling 500.
    forkSession(f.db, f.sessionId, seam.id);
    const b1 = assistant(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "step",
      200,
    );
    assistant(f.db, f.sessionId, b1.id, "expensive answer", 300);
    const headB = currentHead(listEvents(f.db, f.sessionId));

    const cmp = compareBranches(
      f.db,
      f.sessionId,
      headA as string,
      headB as string,
    );
    expect(cmp.common_ancestor).toBe(seam.id);
    expect(cmp.a.cost_micro_usd).toBe(100);
    expect(cmp.b.cost_micro_usd).toBe(500);
    expect(cmp.a.last_text).toBe("cheap answer");
    expect(cmp.b.last_text).toBe("expensive answer");
    // Outcome carries the branch lifecycle (SES-7) — both end on an assistant
    // message with no pending tool calls, so both read "done".
    expect(cmp.a.lifecycle).toBe("done");
    expect(cmp.b.lifecycle).toBe("done");
    // Cheaper branch identifiable.
    expect(cmp.a.cost_micro_usd).toBeLessThan(cmp.b.cost_micro_usd);
  });

  it("identical heads report a zero delta and full shared prefix; store unchanged", () => {
    const f = fixture([]);
    const head = currentHead(listEvents(f.db, f.sessionId)) as string;
    const before = listEvents(f.db, f.sessionId).length;
    const cmp = compareBranches(f.db, f.sessionId, head, head);
    expect(cmp.a.cost_micro_usd).toBe(cmp.b.cost_micro_usd);
    expect(cmp.common_ancestor).toBe(head);
    expect(cmp.shared_prefix).toBe(cmp.a.event_count);
    // Read-only: no events appended.
    expect(listEvents(f.db, f.sessionId).length).toBe(before);
  });
});
