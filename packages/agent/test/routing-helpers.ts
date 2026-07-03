import { policyHash } from "@kelson/kernel";
import type {
  AgentRegistryEntry,
  ModelRegistryEntry,
  RoutingPolicy,
} from "@kelson/schemas";
import type { LanguageModel } from "ai";
import type { RoutingContext } from "../src/routing.ts";
import { mockModel } from "./helpers.ts";

// A two-rule policy: mechanical/T0 → cheap (small budget), else default →
// standard. budgetTokens is low so a couple of steps cross 2×.
export const testRoutingContext = (budgetTokens = 100): RoutingContext => {
  const policy: RoutingPolicy = {
    schema_version: 1,
    rules: [
      {
        match: { task_type: "mechanical", tier: "T0" },
        target: "small",
        effort: "low",
        loadout: [],
        budget_tokens: budgetTokens,
        escalation: ["mid", "frontier"],
      },
      {
        // A T1 (governed-file) step routes to mid with a ladder up to frontier
        // — exercises AGT-12's obligation-fail escalation.
        match: { tier: "T1" },
        target: "mid",
        effort: "high",
        loadout: [],
        budget_tokens: budgetTokens,
        escalation: ["frontier"],
      },
    ],
    default: {
      target: "frontier",
      effort: "high",
      loadout: [],
      budget_tokens: budgetTokens,
      escalation: [],
    },
  };
  const registry: AgentRegistryEntry[] = [
    {
      schema_version: 1,
      id: "small",
      kind: "base_model",
      capabilities: [],
      cost_class: 1,
      constraints: {},
      endpoint: { type: "base_model", ref: "mock-small" },
    },
    {
      schema_version: 1,
      id: "mid",
      kind: "base_model",
      capabilities: [],
      cost_class: 2,
      constraints: {},
      endpoint: { type: "base_model", ref: "mock-mid" },
    },
    {
      schema_version: 1,
      id: "frontier",
      kind: "base_model",
      capabilities: [],
      cost_class: 3,
      constraints: {},
      endpoint: { type: "base_model", ref: "mock-frontier" },
    },
  ];
  // explore: false → deterministic routing in fixtures (exploration is a
  // production behavior tested separately where the explored model is scripted).
  return {
    policy,
    registry,
    policyVersion: policyHash(policy),
    explore: false,
  };
};

// A resolveModel that hands back ONE mock model per routed id (cached, so its
// scripted responses advance across the steps that route to it), exercising
// the loop's per-step routing + model instantiation-by-id.
export const mockResolveModel = (
  responsesById: Record<string, unknown[][]>,
) => {
  const cache = new Map<string, LanguageModel>();
  return (ref: string): { entry: ModelRegistryEntry; model: LanguageModel } => {
    const entry: ModelRegistryEntry = {
      id: ref,
      provider: "anthropic",
      context_window: 1_000_000,
      max_output: 64_000,
      prices: { in: 1, out: 1, cache_read: 1, cache_write: 1 },
      tools: true,
    };
    let model = cache.get(ref);
    if (!model) {
      model = mockModel(responsesById[ref] ?? []);
      cache.set(ref, model);
    }
    return { entry, model };
  };
};
