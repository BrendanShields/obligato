import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookDefinition, HookEvent } from "@obligato/schemas";
import { listEvents } from "../src/sessions.ts";

// A hook script written into the fixture dir (the hook's cwd). Commands never
// interpolate content — the script IS the command's argument.
export const hookScript = (dir: string, name: string, body: string): string => {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return `sh ${path}`;
};

export const hook = (
  event: HookEvent,
  command: string,
  extra: { matcher?: string; timeout_ms?: number } = {},
): HookDefinition => ({ event, command, ...extra });

export const hookRuns = (
  db: Parameters<typeof listEvents>[0],
  sessionId: string,
): Record<string, unknown>[] =>
  listEvents(db, sessionId)
    .filter((e) => e.kind === "session_meta" && e.payload.hook_run)
    .map((e) => e.payload.hook_run as Record<string, unknown>);

export const hookErrors = (
  db: Parameters<typeof listEvents>[0],
  sessionId: string,
): Record<string, unknown>[] =>
  listEvents(db, sessionId)
    .filter((e) => e.kind === "session_meta" && e.payload.hook_error)
    .map((e) => e.payload.hook_error as Record<string, unknown>);

export const toolResults = (
  db: Parameters<typeof listEvents>[0],
  sessionId: string,
) => listEvents(db, sessionId).filter((e) => e.kind === "tool_result");

export const sessionStatus = (
  db: Parameters<typeof listEvents>[0],
  sessionId: string,
): string =>
  (
    db.query("SELECT status FROM session WHERE id = ?").get(sessionId) as {
      status: string;
    }
  ).status;
