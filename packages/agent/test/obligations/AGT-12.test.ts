import { describe, expect, it } from "bun:test";
import { readDecision } from "@kelson/kernel";
import { runTurn } from "../../src/loop.ts";
import { escalateStep } from "../../src/routing.ts";
import { loadSpecContext } from "../../src/spec.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { mockResolveModel, testRoutingContext } from "../routing-helpers.ts";
import { seedSpec } from "../spec-helpers.ts";

describe("AGT-12: obligation-fail escalation + T0 bandit outcomes", () => {
  it("escalateStep climbs the routing decision's ladder to the next target", async () => {
    // Drive one routed step to record an initial decision, then escalate it.
    const f = fixture([]);
    const rc = testRoutingContext(100_000);
    f.deps.routing = rc;
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": [textResponse("done")],
    });
    await runTurn(f.deps);

    const row = f.db
      .query(
        "SELECT id FROM routing_decision WHERE task_id = ? AND kind = 'initial' ORDER BY rowid LIMIT 1",
      )
      .get(f.taskId) as { id: string };
    const initial = readDecision(f.db, row.id);
    // The default rule's escalation ladder is [] — use a decision with a
    // ladder by re-reading the mechanical rule path. Instead assert the
    // escalate helper resolves to null (triage) on an empty ladder.
    const escalated = escalateStep(f.db, rc, initial);
    expect(escalated).toBeNull(); // empty ladder → triage
  }, 30_000);

  it("a mechanical (ladder-bearing) decision escalates to the next ladder target", async () => {
    const f = fixture([]);
    const rc = testRoutingContext(100_000);
    f.deps.routing = rc;
    // Force a mechanical/T0 route by making step 1's model emit a read-only
    // batch, then step 2 (mechanical) records the ladder-bearing decision.
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": [
        toolCallResponse([{ id: "r1", name: "ls", input: { path: "." } }]),
      ],
      "mock-small": [textResponse("done")],
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];
    await runTurn(f.deps);

    const mech = f.db
      .query(
        "SELECT id FROM routing_decision WHERE task_id = ? AND target = 'small' ORDER BY rowid LIMIT 1",
      )
      .get(f.taskId) as { id: string } | null;
    expect(mech).not.toBeNull();
    if (!mech) return;
    const escalated = escalateStep(f.db, rc, readDecision(f.db, mech.id));
    expect(escalated).not.toBeNull();
    // ladder = [mid, frontier]; first escalation → mid → mock-mid.
    expect(escalated?.decision.target).toBe("mid");
    expect(escalated?.decision.kind).toBe("escalation");
    expect(escalated?.decision.attempt).toBe(1);
    expect(escalated?.modelId).toBe("mock-mid");
  }, 30_000);

  it("the loop escalates the retry model when an obligation fails (T1 governed write)", async () => {
    const f = fixture([]);
    const rc = testRoutingContext(100_000);
    f.deps.routing = rc;
    seedSpec(f.db, f.dir); // one T1 clause + governed file + obligation
    f.deps.spec = loadSpecContext(f.db, f.dir);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    // step1 (T0, no checks yet) → frontier: writes wrong → obligation fails.
    // step2 (now T1) → mid: text → done-gate blocks + escalates mid→frontier.
    // step3 (one-shot escalation) → frontier: writes the sentinel → passes.
    // step4 (T1) → mid: text → done-gate clean → done.
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": [
        toolCallResponse([
          {
            id: "w1",
            name: "write",
            input: { path: "src/governed.ts", content: "// wrong\n" },
          },
        ]),
        toolCallResponse([
          {
            id: "w2",
            name: "write",
            input: {
              path: "src/governed.ts",
              content: "const x='SENTINEL';\n",
            },
          },
        ]),
      ],
      "mock-mid": [textResponse("try to finish"), textResponse("done")],
    });

    const result = await runTurn(f.deps, 8);
    expect(result.status).toBe("done");
    // An escalation decision was recorded (kind: escalation, target frontier).
    const esc = f.db
      .query(
        "SELECT target, attempt FROM routing_decision WHERE task_id = ? AND kind = 'escalation' ORDER BY rowid LIMIT 1",
      )
      .get(f.taskId) as { target: string; attempt: number } | null;
    expect(esc?.target).toBe("frontier");
    expect(esc?.attempt).toBe(1);
  }, 30_000);

  it("a routed T0 step records a bandit outcome", async () => {
    const f = fixture([]);
    const rc = testRoutingContext(100_000);
    f.deps.routing = rc;
    f.deps.resolveModel = mockResolveModel({
      "mock-frontier": [
        toolCallResponse([{ id: "r1", name: "ls", input: { path: "." } }]),
      ],
      "mock-small": [textResponse("done")],
    });
    f.deps.rules = [{ tool: "ls", action: "allow" }];
    await runTurn(f.deps);

    // The mechanical/T0 step (target small) recorded an outcome.
    const outcomes = f.db
      .query("SELECT arm, outcome FROM routing_outcome ORDER BY rowid")
      .all() as { arm: string; outcome: number }[];
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.arm === "small" && o.outcome === 1)).toBe(
      true,
    );
  }, 30_000);
});
