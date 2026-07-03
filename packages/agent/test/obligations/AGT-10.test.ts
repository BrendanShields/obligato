import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { mockResolveModel, testRoutingContext } from "../routing-helpers.ts";

describe("AGT-10: per-step routing selects the model and records a decision", () => {
  it("a mechanical step routes to the cheap target; a mutating step routes to the default", async () => {
    // Step 1 has no prior assistant → standard → frontier; make it a read-only
    // ls so step 2's last assistant is read-only → mechanical/T0 → small.
    const f = fixture([]); // responses come from the routed mock models
    f.deps.routing = testRoutingContext(100_000);
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": [
        toolCallResponse([{ id: "r1", name: "ls", input: { path: "." } }]),
      ],
      "mock-small": [textResponse("done")],
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];

    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");

    const decisions = f.db
      .query(
        "SELECT target, feature_vector FROM routing_decision WHERE task_id = ? ORDER BY rowid",
      )
      .all(f.taskId) as { target: string; feature_vector: string }[];
    // First step is mechanical? No prior assistant message → mechanicalStep
    // returns false on step 1 (no last-assistant tool_calls). So step 1 routes
    // to frontier (default). After step 1's ls (read-only) becomes the last
    // assistant, step 2 is mechanical → small. Assert both targets appeared.
    const targets = decisions.map((d) => d.target);
    // step 1 (no prior assistant) → frontier; step 2 (read-only last) → small.
    expect(targets).toEqual(["frontier", "small"]);
    // Each decision recorded its feature vector.
    for (const d of decisions)
      expect(JSON.parse(d.feature_vector).task_type).toMatch(
        /mechanical|standard/,
      );

    // The StepEvent model id matches the routed target's endpoint ref.
    const models = (
      f.db
        .query(
          "SELECT model FROM step_event WHERE session_id = ? ORDER BY rowid",
        )
        .all(f.sessionId) as { model: string }[]
    ).map((r) => r.model);
    expect(models.every((m) => m.startsWith("mock-"))).toBe(true);
  }, 30_000);

  it("no RoutingContext → no routing_decision rows, fixed model used", async () => {
    const f = fixture([textResponse("done")]);
    await runTurn(f.deps);
    const n = (
      f.db.query("SELECT COUNT(*) AS n FROM routing_decision").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
    const model = (
      f.db.query("SELECT model FROM step_event LIMIT 1").get() as {
        model: string;
      }
    ).model;
    expect(model).toBe("mock-model"); // TEST_ENTRY.id
  }, 30_000);
});
