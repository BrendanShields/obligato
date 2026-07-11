import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BudgetMonitor,
  escalate,
  exploreDecision,
  extractFeatures,
  loadPolicy,
  loadRegistry,
  policyHash,
  recordOutcome,
  route,
  stepTriageState,
  ulid,
} from "@obligato/kernel";
import type {
  AgentRegistryEntry,
  RoutingDecision,
  RoutingPolicy,
} from "@obligato/schemas";

// AGT-10..12: an optional routing pack loaded from the operator repo. Absent
// => the session's fixed model and an unbounded budget (Phases 6–8).
export interface RoutingContext {
  policy: RoutingPolicy;
  registry: AgentRegistryEntry[];
  policyVersion: string;
  // AGT-10: bandit exploration draw on mechanical/T0 steps. Default (undefined)
  // = on (production); tests set false for deterministic routing.
  explore?: boolean;
}

// The routing pack layout (packs/routing-default): routing/policy.yaml +
// agents/*.yaml. Looked up under <repo>/.obligato/routing or an explicit dir.
export const loadRoutingContext = (
  repo: string,
  dir?: string,
): RoutingContext | null => {
  const base = dir ?? join(repo, ".obligato", "routing");
  const policyPath = join(base, "policy.yaml");
  const agentsDir = join(base, "agents");
  if (!existsSync(policyPath) || !existsSync(agentsDir)) return null;
  const policy = loadPolicy(policyPath);
  return {
    policy,
    registry: loadRegistry(agentsDir),
    policyVersion: policyHash(policy),
  };
};

// A routed target id resolves through the registry to the concrete model id
// (endpoint.ref), which the loop's resolveModel then instantiates.
export const targetModelId = (
  rc: RoutingContext,
  target: string,
): string | null => {
  const entry = rc.registry.find((e) => e.id === target);
  return entry?.endpoint.ref ?? null;
};

export interface RoutedStep {
  decision: RoutingDecision;
  modelId: string;
  explored: AgentRegistryEntry | null;
}

// AGT-10: route one step from live session state. mechanical/T0 steps draw a
// bandit exploration; the caller records the outcome after the step.
export const routeStep = (
  db: Database,
  rc: RoutingContext,
  args: {
    taskId: string;
    stepEventId: string;
    repo: string;
    mechanical: boolean;
    tier: "T0" | "T1" | "T2";
  },
): RoutedStep => {
  const vector = extractFeatures({
    step: "build",
    repo: args.repo,
    touchedTiers: [args.tier],
    mechanical: args.mechanical,
  });
  const decision = route(db, {
    policy: rc.policy,
    registry: rc.registry,
    vector,
    taskId: args.taskId,
    stepId: args.stepEventId,
  });
  const exploit = rc.registry.find((e) => e.id === decision.target);
  const explored =
    exploit && rc.explore !== false && (args.mechanical || args.tier === "T0")
      ? exploreDecision(vector, exploit, rc.registry, args.stepEventId)
      : null;
  const chosen = explored?.id ?? decision.target;
  return {
    decision,
    modelId: targetModelId(rc, chosen) ?? decision.target,
    explored,
  };
};

// AGT-12: record the bandit outcome for an explored/exploited T0 arm.
export const recordStepOutcome = (
  db: Database,
  rc: RoutingContext,
  arm: string,
  ok: boolean,
): void => {
  recordOutcome(db, rc.policyVersion, arm, ok ? 1 : 0);
};

// AGT-12: escalate a step's routing decision to the next ladder target after
// an obligation failure. Returns the escalated model id, or null at triage.
export const escalateStep = (
  db: Database,
  rc: RoutingContext,
  prev: RoutingDecision,
): { modelId: string; decision: RoutingDecision } | null => {
  const outcome = escalate(db, rc.policy, prev);
  if (outcome.kind !== "escalated") return null;
  return {
    decision: outcome.decision,
    modelId:
      targetModelId(rc, outcome.decision.target) ?? outcome.decision.target,
  };
};

// AGT-11: a session-level BudgetMonitor keyed by the session id (the accounting
// scope), seeded once from the first routed budget. Pause state is stream-
// derived (isPausedForTriage) so a fresh process re-derives the pause even
// though the in-process counter resets on restart.
export const newSessionBudget = (
  db: Database,
  sessionId: string,
  policyVersion: string,
  seedTokens: number,
): BudgetMonitor =>
  new BudgetMonitor(db, {
    taskId: sessionId,
    stepId: sessionId,
    attempt: 0,
    ruleId: "session",
    policyHash: policyVersion,
    modelId: "session",
    escalationDepth: 0,
    budgetTokens: seedTokens,
  });

// AGT-11: a durable budget suspension — paused (awaiting triage) OR blocked
// (headless hit the extension cap). Either short-circuits a fresh runTurn so a
// re-invocation never re-runs steps past the cap.
export const sessionPausedForBudget = (
  db: Database,
  sessionId: string,
): boolean => stepTriageState(db, sessionId) !== "running";
