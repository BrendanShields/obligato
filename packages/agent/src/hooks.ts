import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HookDefinition,
  type HookEvent,
  HooksFile,
} from "@obligato/schemas";
import { matchesGlob } from "./permissions.ts";

export const HOOKS_FILE = join(".obligato", "hooks.json");
const DEFAULT_TIMEOUT_MS = 10_000;

// AGT-20: missing file → no hooks; invalid file → validation error at load
// (the loadRules precedent).
export const loadHooks = (repoRoot: string): HookDefinition[] => {
  const path = join(repoRoot, HOOKS_FILE);
  if (!existsSync(path)) return [];
  return HooksFile.parse(JSON.parse(readFileSync(path, "utf8"))).hooks;
};

// AGT-20: matcher is a PERM-1 tool glob (same matcher, F-085), consulted for
// tool events only; absent = every tool.
export const matchingHooks = (
  hooks: HookDefinition[],
  event: HookEvent,
  tool?: string,
): HookDefinition[] =>
  hooks.filter(
    (h) =>
      h.event === event &&
      (tool === undefined ||
        h.matcher === undefined ||
        matchesGlob(h.matcher, tool)),
  );

export interface HookPayload {
  event: HookEvent;
  session_id: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
}

export type HookFailure =
  | "timeout"
  | "spawn_error"
  | `spawn_error:${string}`
  | `exit:${number}`;

// AGT-22: output past this cap is a spawn-class failure (ENOBUFS).
export const HOOK_MAX_BUFFER = 10 * 1024 * 1024;

export interface HookResult {
  hook: HookDefinition;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  // AGT-22: null = ran as specified (exit 0 or 2).
  failure: HookFailure | null;
}

// AGT-20: `sh -c <command>`, payload on stdin (never interpolated), repo root
// as cwd, killed at timeout_ms.
export const runHook = (
  hook: HookDefinition,
  payload: HookPayload,
  cwd: string,
): HookResult => {
  const started = performance.now();
  const r = spawnSync("sh", ["-c", hook.command], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: hook.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, OBLIGATO_SESSION_ID: payload.session_id },
    maxBuffer: HOOK_MAX_BUFFER,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const err = r.error as NodeJS.ErrnoException | undefined;
  // AGT-22: only ETIMEDOUT is a timeout — a bare SIGTERM (maxBuffer overflow
  // = ENOBUFS, or an external kill) is a spawn-class failure, not a timeout.
  const timedOut = err?.code === "ETIMEDOUT";
  // Bun reports `status: undefined` on a spawn error where node reports null.
  const exitCode = r.status ?? null;
  const failure: HookFailure | null = timedOut
    ? "timeout"
    : err !== undefined
      ? err.code !== undefined
        ? `spawn_error:${err.code}`
        : "spawn_error"
      : exitCode === null
        ? "spawn_error"
        : exitCode === 0 || exitCode === 2
          ? null
          : `exit:${exitCode}`;
  return {
    hook,
    exitCode: timedOut ? null : exitCode,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    durationMs,
    failure,
  };
};

// AGT-21: the block/error line — first non-empty stderr line, else the command.
export const hookMessage = (result: HookResult): string =>
  result.stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? result.hook.command;

// AGT-20: the observability record shape (recorded by the caller — on the
// chain for tool/session_end runs, on the root payload for session_start).
export const hookRunRecord = (
  result: HookResult,
  blocked: boolean,
  tool?: string,
): Record<string, unknown> => ({
  event: result.hook.event,
  command: result.hook.command,
  ...(tool !== undefined ? { tool } : {}),
  exit_code: result.exitCode,
  duration_ms: result.durationMs,
  blocked,
});

// AGT-22: the degrade record.
export const hookErrorRecord = (
  result: HookResult,
): Record<string, unknown> => ({
  event: result.hook.event,
  command: result.hook.command,
  reason: result.failure ?? "spawn_error",
});
