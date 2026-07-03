import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { resolveCredential, saveCredential } from "../../src/llm/auth.ts";
import { instantiate } from "../../src/llm/resolve.ts";
import { runTurn } from "../../src/loop.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import { fixture } from "../helpers.ts";

describe("PROV-5: subscription token precedence and Bearer wiring", () => {
  it("resolves stored > ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kelson-auth-")), "auth.json");
    const both = {
      ANTHROPIC_API_KEY: "sk-env",
      CLAUDE_CODE_OAUTH_TOKEN: "tok-env",
    };
    expect(resolveCredential("anthropic", path, both)).toEqual({
      type: "api_key",
      key: "sk-env",
    });
    expect(
      resolveCredential("anthropic", path, {
        CLAUDE_CODE_OAUTH_TOKEN: "tok-env",
      }),
    ).toEqual({ type: "token", token: "tok-env" });
    saveCredential("anthropic", { type: "token", token: "tok-stored" }, path);
    expect(resolveCredential("anthropic", path, both)).toEqual({
      type: "token",
      token: "tok-stored",
    });
  });

  it("a token credential's request carries Bearer + the OAuth beta header and no x-api-key", async () => {
    // Local capture server standing in for the anthropic endpoint.
    let headers: Record<string, string> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        headers = Object.fromEntries(req.headers.entries());
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "capture only" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
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
      model: instantiate(entry, { type: "token", token: "tok-sub" }),
      tools: CORE_TOOLS,
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    };
    await runTurn(deps).catch(() => {});
    server.stop(true);
    expect(headers).not.toBeNull();
    const h = headers as unknown as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok-sub");
    expect(h["anthropic-beta"] ?? "").toContain("oauth-2025-04-20");
    expect(h["x-api-key"]).toBeUndefined();
  });
});
