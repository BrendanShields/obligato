import { describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@obligato/schemas";
import { instantiate } from "../../src/llm/resolve.ts";
import { runTurn } from "../../src/loop.ts";
import { fixture } from "../helpers.ts";

describe("PROV-7: a 401 on a subscription token names the re-mint path, once", () => {
  it("surfaces claude setup-token and makes exactly one request", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "token expired" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
    });
    const entry: ModelRegistryEntry = {
      id: "claude-opus-4-8",
      provider: "anthropic",
      base_url: `http://127.0.0.1:${server.port}`,
      context_window: 1_000_000,
      max_output: 64_000,
      prices: null,
      tools: true,
    };
    const f = fixture([]);
    const deps = {
      ...f.deps,
      entry,
      model: instantiate(entry, { type: "token", token: "tok-expired" }),
      authKind: "subscription" as const,
    };
    let message = "";
    await runTurn(deps).catch((err: Error) => {
      message = err.message;
    });
    server.stop(true);
    expect(message).toContain("claude setup-token");
    expect(message).toContain("PROV-7");
    expect(requests).toBe(1);
  });
});
