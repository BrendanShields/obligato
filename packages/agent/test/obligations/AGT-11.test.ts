import { describe, expect, it } from "bun:test";
import { budgetEvents } from "@kelson/kernel";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { mockResolveModel, testRoutingContext } from "../routing-helpers.ts";

// USAGE_FIXTURE totals 105 tokens/step (70+5+20+10). With a 100-token routed
// budget, 2× = 200: step 1 (105) crosses 1×, step 2 (210 cumulative) pauses.
// Tool-call ids are prefixed per model — two models sharing an id would make
// the SDK reject the reconstructed prompt (duplicate unresolved tool call).
const stepResponses = (n: number, prefix: string): unknown[][] =>
  Array.from({ length: n }, (_, i) =>
    i === n - 1
      ? textResponse("done")
      : toolCallResponse([
          { id: `${prefix}${i}`, name: "ls", input: { path: "." } },
        ]),
  );

describe("AGT-11: session budget pauses at 2× with triage; headless auto-resolves; resumable", () => {
  it("cumulative usage crossing 2× pauses with reason budget and the 1×/2×/triage events in order", async () => {
    const f = fixture([]);
    f.deps.routing = testRoutingContext(100);
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": stepResponses(4, "f"),
      "mock-small": stepResponses(4, "s"),
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];

    const result = await runTurn(f.deps, 10);
    expect(result.status).toBe("paused");
    if (result.status === "paused") expect(result.reason).toBe("budget");

    const kinds = budgetEvents(f.db, f.sessionId).map((e) => e.kind);
    expect(kinds).toEqual(["overrun", "overrun", "triage_requested"]);
  }, 30_000);

  it("headless grants exactly CAP continue-extensions then blocks (not step_limit)", async () => {
    const f = fixture([]);
    f.deps.routing = testRoutingContext(100);
    // Enough read-only steps to burn through 2× + CAP× budget and hit the cap.
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": stepResponses(12, "f"),
      "mock-small": stepResponses(12, "s"),
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];
    f.deps.headlessAsk = "allow"; // headless

    const result = await runTurn(f.deps, 20);
    // Discriminating: the block MUST fire (not merely reach step_limit).
    expect(result.status).toBe("paused");
    if (result.status === "paused")
      expect(result.reason).toBe("budget:blocked");
    // Exactly CAP (=2) continue-extensions, then one block.
    const resolves = budgetEvents(f.db, f.sessionId).filter(
      (e) => e.kind === "triage_resolved",
    ) as { action: string }[];
    expect(resolves.filter((r) => r.action === "continue").length).toBe(2);
    expect(resolves.filter((r) => r.action === "block").length).toBe(1);
  }, 30_000);

  it("a durable budget pause survives a fresh process (resumable)", async () => {
    const f = fixture([]);
    f.deps.routing = testRoutingContext(100);
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": stepResponses(4, "f"),
      "mock-small": stepResponses(4, "s"),
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];
    await runTurn(f.deps, 10); // reaches the pause

    // Fresh runTurn with a fresh holder (simulating a new process) re-derives
    // the pause from the event stream without running a step.
    const before = budgetEvents(f.db, f.sessionId).length;
    const resumed = await runTurn(
      { ...f.deps, budgetHolder: { monitor: null } },
      10,
    );
    expect(resumed.status).toBe("paused");
    if (resumed.status === "paused") expect(resumed.reason).toBe("budget");
    // No step ran → no new budget events.
    expect(budgetEvents(f.db, f.sessionId).length).toBe(before);
  }, 30_000);

  it("no RoutingContext → no budget monitor, session runs unbounded", async () => {
    const f = fixture([textResponse("done")]);
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    expect(budgetEvents(f.db, f.sessionId)).toEqual([]);
  }, 30_000);
});
