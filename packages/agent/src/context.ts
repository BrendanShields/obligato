import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@kelson/kernel";
import type { SessionEvent } from "@kelson/schemas";
import type { ModelMessage, SystemModelMessage } from "ai";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export const toMessages = (chain: SessionEvent[]): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (const e of chain) {
    if (e.kind === "user_message") {
      messages.push({ role: "user", content: String(e.payload.text) });
    } else if (e.kind === "assistant_message") {
      const calls = (e.payload.tool_calls ?? []) as ToolCall[];
      const content = [
        ...(e.payload.text
          ? [{ type: "text" as const, text: String(e.payload.text) }]
          : []),
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.id,
          toolName: c.name,
          input: c.input,
        })),
      ];
      // SES-4: a done turn can carry neither text nor tool calls; providers
      // reject an empty-content assistant message on --continue, so drop it —
      // it references no tool results and loses nothing from the chain.
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else if (e.kind === "tool_result") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: String(e.payload.tool_call_id),
            toolName: String(e.payload.name),
            output: { type: "text" as const, value: String(e.payload.output) },
          },
        ],
      });
    }
  }
  return messages;
};

// AGT-15: the one system-prompt builder — chat/run and the api executor both
// compose through here (F-085). Recorded once in the session root (SES-1),
// so it is the PROV-8 cache-stable block; mid-session changes never churn it.
const CONVENTIONS_CAP = 8_000;

export const buildSystemPrompt = (args: {
  identity: string;
  cwd: string;
  exec: (
    command: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ) => ExecResult;
}): string => {
  const parts = [args.identity];

  // Environment block — git line best-effort, absent on failure. Two execs,
  // parsed structurally: a combined command misparses detached HEAD, where
  // --show-current prints nothing and the dirty count masquerades as the
  // branch name (audit 2026-07-05).
  let gitLine = "";
  try {
    // --show-current (not rev-parse): survives an unborn HEAD in a fresh repo
    const branch = args.exec("git branch --show-current 2>/dev/null", {
      timeoutMs: 5_000,
    });
    const name = branch.stdout.trim();
    if (branch.exitCode === 0 && name.length > 0) {
      const dirty = args.exec("git status --porcelain 2>/dev/null | wc -l", {
        timeoutMs: 5_000,
      });
      gitLine = `\ngit: branch ${name}, ${Number(dirty.stdout.trim() || 0)} dirty file(s)`;
    }
  } catch {
    // non-git workspace or no git binary — omit, never error
  }
  parts.push(
    `Environment:\ncwd: ${args.cwd}\nplatform: ${process.platform}\ndate: ${new Date().toISOString().slice(0, 10)}${gitLine}`,
  );

  // Workspace conventions: AGENTS.md, else CLAUDE.md, capped with notice.
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(args.cwd, name);
    if (!existsSync(p)) continue;
    let text = readFileSync(p, "utf8");
    if (text.length > CONVENTIONS_CAP)
      text = `${text.slice(0, CONVENTIONS_CAP)}\n(truncated at ${CONVENTIONS_CAP} characters)`;
    parts.push(`Project conventions (${name}):\n${text}`);
    break;
  }
  return parts.join("\n\n");
};

export interface AssembledContext {
  // ai v7 requires system content via `instructions` (system-role entries in
  // `messages` are rejected); a SystemModelMessage carries providerOptions —
  // the documented caching path.
  instructions: SystemModelMessage;
  messages: ModelMessage[];
}

// PROV-8: the two prompt-cache breakpoints — the system block and the final
// message. Provider-namespaced: non-Anthropic providers ignore it, so the
// seam carries no provider branching. Shape read from the installed
// @ai-sdk/anthropic .d.ts (message-level providerOptions → cache_control on
// the message's last part), never from memory.
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

// The SOLE producer of model input: every byte the model sees for a step is
// assembled here from the reconstructed chain — the one seam where prompt
// caching (PROV-8) and auto-compaction attach. The chain's first event is
// the session_meta root carrying the system prompt (SES-1 shape); the
// append-only chain makes each step's prefix byte-stable, so everything
// before the tail breakpoint reads from cache on the next step.
export const assembleContext = (chain: SessionEvent[]): AssembledContext => {
  const meta = chain[0];
  if (!meta || meta.kind !== "session_meta")
    throw new Error("session has no session_meta root");
  const messages = toMessages(chain);
  if (messages.length > 0) {
    const last = messages[messages.length - 1] as ModelMessage;
    messages[messages.length - 1] = {
      ...last,
      providerOptions: { ...last.providerOptions, ...CACHE_BREAKPOINT },
    } as ModelMessage;
  }
  return {
    instructions: {
      role: "system",
      content: String(meta.payload.system),
      providerOptions: CACHE_BREAKPOINT,
    },
    messages,
  };
};
