import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SHIPPED_MODELS, saveConfig, saveCredential } from "@obligato/agent";
import { ModelRegistryEntry } from "@obligato/schemas";
import { z } from "zod";
import { write } from "../components/sink.js";
import { fail } from "./common.js";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

const writeOverlay = (entries: ModelRegistryEntry[]): void => {
  const path = join(homedir(), ".obligato", "models.json");
  const existing = existsSync(path)
    ? z.array(ModelRegistryEntry).parse(JSON.parse(readFileSync(path, "utf8")))
    : [];
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const e of entries) byId.set(e.id, e);
  writeFileSync(path, JSON.stringify([...byId.values()], null, 2));
};

// UX-16/PROV-4: flags-based so scripted logins work; never echoes the key.
export const authCommand = async (argv: string[]): Promise<void> => {
  const [sub, provider] = argv;
  if (sub !== "login" || !provider)
    return fail(
      "usage: obligato auth login <anthropic|ollama> [--key <api-key> | --token <setup-token>] [--model --base-url]",
    );
  const named: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--") && argv[i + 1] !== undefined) {
      named[a.slice(2)] = argv[i + 1] as string;
      i++;
    }
  }
  const root = process.cwd();
  if (!existsSync(join(root, ".obligato")))
    return fail("no .obligato directory — run `obligato init` first");

  if (provider === "anthropic") {
    // PROV-5: --token stores a Claude subscription bearer (`claude
    // setup-token` output); --key stores an API key. One or the other.
    if (named.token && named.key)
      return fail("pass --key or --token, not both");
    const token = named.token ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const key = named.key ?? process.env.ANTHROPIC_API_KEY;
    if (named.token || (!key && token))
      saveCredential("anthropic", { type: "token", token: token as string });
    else if (key) saveCredential("anthropic", { type: "api_key", key });
    else
      return fail(
        "pass --key <api-key> or --token <setup-token> (or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)",
      );
    const model = named.model ?? SHIPPED_MODELS[0]?.id;
    if (!model) return fail("no shipped models — pass --model");
    saveConfig(root, { default_model: model, schema_version: 1 });
    write(`obligato: anthropic configured, default model ${model}`);
    return;
  }

  if (provider === "ollama") {
    const base = (named["base-url"] ?? OLLAMA_DEFAULT).replace(/\/$/, "");
    const res = await fetch(`${base}/api/tags`).catch(() => null);
    if (!res?.ok)
      return fail(`cannot reach ollama at ${base} — is it running?`);
    const tags = (await res.json()) as { models?: { name: string }[] };
    const names = (tags.models ?? []).map((m) => m.name);
    if (names.length === 0)
      return fail(
        `ollama at ${base} has no models — \`ollama pull\` one first`,
      );
    // Local inference is genuinely $0 marginal cost — 0 is true, not a guess.
    writeOverlay(
      names.map((name) => ({
        id: name,
        provider: "openai-compatible" as const,
        base_url: `${base}/v1`,
        context_window: 32_768,
        max_output: 8_192,
        prices: { in: 0, out: 0, cache_read: 0, cache_write: 0 },
        tools: true,
      })),
    );
    const model = named.model ?? (names[0] as string);
    if (!names.includes(model))
      return fail(`model ${model} not in ollama tags: ${names.join(", ")}`);
    saveConfig(root, { default_model: model, schema_version: 1 });
    write(
      `obligato: ollama configured (${names.length} model(s)), default ${model}`,
    );
    return;
  }

  return fail(`unknown provider: ${provider} (have: anthropic, ollama)`);
};
