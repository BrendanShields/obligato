import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  authKindOf,
  buildSystemPrompt,
  CORE_TOOLS,
  instantiate,
  loadConfig,
  loadRegistry as loadModelRegistry,
  loadRoutingContext,
  loadRules,
  loadSpecContext,
  localExec,
  resolveCredential,
  resolveEntry,
  type StepDeps,
} from "@obligato/agent";
import { DEFAULT_DB_PATH, hashLockfile, openDb } from "@obligato/kernel";
import type { AgentConfig, ModelRegistryEntry } from "@obligato/schemas";

export const fail = (msg: string): never => {
  console.error(`obligato: ${msg}`);
  process.exit(1);
};

// Pi-style minimal identity: the model already knows what a coding agent is;
// the harness adds constraints, not lectures. AGT-15 composes the full
// prompt (environment block + workspace conventions) through the one shared
// builder — PROMPT_BUILDER is the identity the obligation test checks.
export const PROMPT_BUILDER = buildSystemPrompt;
const IDENTITY =
  "You are Obligato, a coding agent working in the current repository. " +
  "Use the tools to read, search, and modify files and to run commands. " +
  "Prefer edit over rewriting whole files; search before modifying; verify " +
  "with the project's tests when available. " +
  "When the task is complete, reply with a short summary and stop calling tools.";

export const systemPromptFor = (root: string): string =>
  PROMPT_BUILDER({ identity: IDENTITY, cwd: root, exec: localExec(root) });

export interface AgentSetup {
  deps: Omit<StepDeps, "sessionId">;
  entry: ModelRegistryEntry;
  config: AgentConfig;
  lockfileHash: string;
  root: string;
  authKind: "subscription" | "api_key" | "none";
}

// PROV-4: no configuration → instruct, never probe.
export const setupAgent = (
  root = process.cwd(),
  dbPath = DEFAULT_DB_PATH,
): AgentSetup => {
  const config = loadConfig(root);
  if (!config)
    return fail(
      "no agent configured — run `obligato auth login <provider>` first",
    );
  const lockPath = join(root, "obligato.lock");
  if (!existsSync(lockPath))
    return fail("no obligato.lock — run `obligato init` first");
  const lockfileHash = hashLockfile(JSON.parse(readFileSync(lockPath, "utf8")));

  const entry = resolveEntry(loadModelRegistry(), config.default_model);
  const credential = resolveCredential(
    entry.provider === "anthropic" ? "anthropic" : entry.id,
  );
  // PROV-4: a credential-less anthropic setup fails here with the login
  // instruction, not inside the SDK mid-request. openai-compatible endpoints
  // (local ollama) legitimately run keyless.
  if (entry.provider === "anthropic" && credential === null)
    return fail(
      "no anthropic credential — run `obligato auth login anthropic` first",
    );
  const model = instantiate(entry, credential);
  const authKind = authKindOf(credential);
  const db = openDb(dbPath);
  // UX-17: chain-recorded model switches resolve through the same registry
  // as setup; a credential-less anthropic target fails with the login hint.
  const resolveModel = (ref: string) => {
    const nextEntry = resolveEntry(loadModelRegistry(), ref);
    const nextCredential = resolveCredential(
      nextEntry.provider === "anthropic" ? "anthropic" : nextEntry.id,
    );
    if (nextEntry.provider === "anthropic" && nextCredential === null)
      return fail(
        "no anthropic credential — run `obligato auth login anthropic` first",
      );
    return { entry: nextEntry, model: instantiate(nextEntry, nextCredential) };
  };
  // AGT-7/8/9: spec-native loop over the operator repo's artifact store —
  // empty (inert) when the repo has no trace links.
  const spec = loadSpecContext(db, root);
  // AGT-10..12: live routing + budget from the repo's routing pack, if any.
  const routing = loadRoutingContext(root) ?? undefined;
  return {
    deps: {
      db,
      entry,
      model,
      tools: CORE_TOOLS,
      rules: loadRules(root),
      ctx: { cwd: root, exec: localExec(root) },
      authKind,
      resolveModel,
      spec,
      ...(routing ? { routing } : {}),
    },
    entry,
    config,
    lockfileHash,
    root,
    authKind,
  };
};
