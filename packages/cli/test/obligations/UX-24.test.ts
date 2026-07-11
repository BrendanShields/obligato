import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentsListResult } from "@obligato/schemas";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

// Minimal default registry + policy so `route explain` resolves in the
// fixture repo (route loads packs/routing-default from cwd).
const seedRoutingDefaults = (t: TestRepo): void => {
  const routingDir = join(t.repo, "packs", "routing-default", "routing");
  const agentsDir = join(t.repo, "packs", "routing-default", "agents");
  mkdirSync(routingDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(routingDir, "policy.yaml"),
    JSON.stringify({
      schema_version: 1,
      rules: [],
      default: {
        target: "base-agent",
        effort: "medium",
        budget_tokens: 1000,
      },
    }),
  );
  writeFileSync(
    join(agentsDir, "base-agent.yaml"),
    JSON.stringify({
      schema_version: 1,
      id: "base-agent",
      kind: "base_model",
      cost_class: 1,
      endpoint: { type: "base_model", ref: "mock-m" },
    }),
  );
};

const MANIFEST = {
  schema_version: 1,
  id: "my-tuned",
  kind: "custom_agent",
  capabilities: [{ step: "build" }],
  cost_class: 1,
  endpoint: { type: "base_model", ref: "mock-m" },
};

describe("UX-24: agents register makes the agent a route candidate and a list entry without restart; invalid changes nothing", () => {
  it("a registered agent appears in route explain (capability match) and agents list", async () => {
    const t = makeTestRepo({});
    seedRoutingDefaults(t);
    const manifestPath = join(t.repo, "my-tuned.yaml");
    writeFileSync(manifestPath, JSON.stringify(MANIFEST));
    const reg = await runCli(t, ["agents", "register", manifestPath]);
    expect(reg.exitCode).toBe(0);
    expect(
      existsSync(
        join(t.repo, ".obligato", "routing", "agents", "my-tuned.yaml"),
      ),
    ).toBe(true);

    const route = await runCli(t, [
      "route",
      "explain",
      "--step",
      "build",
      "--json",
    ]);
    expect(route.exitCode).toBe(0);
    const decision = JSON.parse(route.stdout) as {
      target: string;
      via_capability_match: boolean;
    };
    expect(decision.target).toBe("my-tuned");
    expect(decision.via_capability_match).toBe(true);

    const list = await runCli(t, ["agents", "list", "--json"]);
    expect(list.exitCode).toBe(0);
    const parsed = AgentsListResult.parse(JSON.parse(list.stdout));
    const mine = parsed.agents.find((a) => a.id === "my-tuned");
    expect(mine).toBeDefined();
    expect(mine?.capabilities[0]?.step).toBe("build");
  }, 30_000);

  it("an invalid manifest exits non-zero and the registry directory gains no file", async () => {
    const t = makeTestRepo({});
    seedRoutingDefaults(t);
    const manifestPath = join(t.repo, "bogus.yaml");
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...MANIFEST, id: "bogus", kind: "not-a-kind" }),
    );
    const r = await runCli(t, ["agents", "register", manifestPath]);
    expect(r.exitCode).not.toBe(0);
    const dir = join(t.repo, ".obligato", "routing", "agents");
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
  }, 30_000);
});
