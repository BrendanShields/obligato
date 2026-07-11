import { type ExecutorFn, openDb } from "@obligato/kernel";
import { buildSystemPrompt } from "./context.ts";
import { resolveCredential } from "./llm/auth.ts";
import { loadConfig } from "./llm/config.ts";
import { loadRegistry, resolveEntry } from "./llm/registry.ts";
import { instantiate } from "./llm/resolve.ts";
import { runTurn } from "./loop.ts";
import { appendEvent, authKindOf, createAgentSession } from "./sessions.ts";

// EVP-9: the native runtime as an eval executor. The sandbox workspace is
// the ToolContext (AGT-4: worktree isolation composes with zero code here);
// the session chain + telemetry live in an ephemeral in-memory store so an
// eval run never pollutes the operator's session history.
export const apiExecutor: ExecutorFn = async (ctx) => {
  const registry = loadRegistry();
  // Model: the EVP-8 override env wins; else the snapshot repo's own config.
  const modelRef =
    ctx.sideEnv.ANTHROPIC_MODEL ?? loadConfig(ctx.workspace.dir)?.default_model;
  if (!modelRef)
    throw new Error(
      `executor "api" needs a model: set --model or commit .obligato/config.json in the task snapshot (task ${ctx.task.id})`,
    );
  const entry = resolveEntry(registry, modelRef);
  // EVP-8: sessions pointed at an override endpoint never carry operator
  // credentials — mirror buildClaudeEnv's rule for the native path.
  const overridden = ctx.sideEnv.ANTHROPIC_BASE_URL !== undefined;
  const resolved = resolveCredential(
    entry.provider === "anthropic" ? "anthropic" : entry.id,
  );
  // EVP-8: a session pointed at an override endpoint never carries operator
  // credentials. A bare null is NOT enough — the AI SDK's anthropic adapter
  // falls back to process.env.ANTHROPIC_API_KEY, leaking the real key to the
  // arbitrary endpoint (audit F-119). Substitute the dummy key, exactly as
  // buildClaudeEnv does for the claude executor.
  const credential = overridden
    ? ({ type: "api_key", key: "obligato-local" } as const)
    : resolved;
  const model = instantiate(
    overridden ? { ...entry, base_url: ctx.sideEnv.ANTHROPIC_BASE_URL } : entry,
    credential,
  );

  const db = openDb(":memory:");
  const { sessionId, rootEventId } = createAgentSession(db, {
    repo: ctx.workspace.dir,
    lockfile_hash: `sha256:${"0".repeat(64)}`,
    harness_version: "0.0.1",
    model: entry.id,
    // AGT-15: the shared builder — benchmark identity + workspace env block.
    system: buildSystemPrompt({
      identity:
        "You are Obligato, a coding agent completing a benchmark task in this workspace. " +
        "Use the tools; prefer edit over rewriting whole files; verify with the " +
        "project's tests when available. When the task is complete, reply with a " +
        "short summary and stop calling tools.",
      cwd: ctx.workspace.dir,
      exec: ctx.workspace.exec,
    }),
    auth_kind: authKindOf(credential),
  });
  appendEvent(db, {
    session_id: sessionId,
    parent_id: rootEventId,
    kind: "user_message",
    payload: { text: ctx.task.statement },
  });

  try {
    const result = await runTurn({
      db,
      sessionId,
      entry,
      model,
      tools: (await import("./tools.ts")).CORE_TOOLS,
      rules: [],
      ctx: { cwd: ctx.workspace.dir, exec: ctx.workspace.exec },
      // PROV-7: a subscription-auth eval run surfaces the re-mint path on 401.
      authKind: authKindOf(credential),
      // Isolation is the boundary in an eval sandbox (SEC-1); a headless
      // session cannot answer asks — same rationale as claude's
      // --dangerously-skip-permissions.
      headlessAsk: "allow",
      abort: AbortSignal.timeout(ctx.timeoutMs),
    });
    const rows = db
      .query(
        "SELECT COUNT(*) - COUNT(cost_micro_usd) AS unknowns, COALESCE(SUM(cost_micro_usd), 0) AS cost FROM step_event WHERE session_id = ?",
      )
      .get(sessionId) as { unknowns: number; cost: number };
    return {
      ok: result.status === "done",
      // EVP §2.1: an unpriced model records 0 with a warning detail — never
      // a silent zero (readCostFile discipline).
      cost_micro_usd: rows.cost,
      detail:
        result.status === "done"
          ? rows.unknowns > 0
            ? `cost incomplete: ${rows.unknowns} step(s) on an unpriced model recorded as 0`
            : null
          : `session ${result.status}${result.status === "paused" ? `: ${result.reason}` : ""}`,
      raw_ref: result.status === "done" ? result.text : null,
    };
  } catch (err) {
    return {
      ok: false,
      cost_micro_usd: 0,
      detail: `session failed: ${(err as Error).message}`,
      raw_ref: null,
    };
  } finally {
    db.close();
  }
};
