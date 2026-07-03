import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkTask, type TaskCheck } from "@kelson/schemas";
import { currentHead, listEvents, reconstructFrom } from "./sessions.ts";
import { obligationChecks } from "./spec.ts";

// EVP-10: compile a finished session into a staging BenchmarkTask. statement =
// first user message, snapshot = the session's recorded snapshot, checks = one
// obligations check + one command per touched clause, budget = cost × 1.5.
// Promotion runs no model; replay is the existing runEval over this task.
export const promoteSession = (
  db: Database,
  sessionId: string,
  stagingSuiteDir: string,
): BenchmarkTask => {
  const events = listEvents(db, sessionId);
  const head = currentHead(events);
  if (head === null)
    throw new Error(`no session ${sessionId} in the store (EVP-10)`);
  const chain = reconstructFrom(events, head);

  const root = events.find((e) => e.parent_id === null);
  const snapshot = root?.payload.snapshot;
  if (typeof snapshot !== "string")
    throw new Error(
      `session ${sessionId} has no snapshot — a promotable session must have captured one at start (EVP-10)`,
    );

  const firstUser = chain.find((e) => e.kind === "user_message");
  if (!firstUser)
    throw new Error(`session ${sessionId} has no user message (EVP-10)`);
  const statement = String(firstUser.payload.text);

  const touched = [
    ...new Set(obligationChecks(chain).map((c) => c.clause_id)),
  ].sort();
  const cost = chain
    .filter((e) => e.kind === "assistant_message")
    .reduce((sum, e) => sum + Number(e.payload.cost_micro_usd ?? 0), 0);

  const checks: TaskCheck[] = [
    { kind: "obligations" },
    ...touched.map(
      (c): TaskCheck => ({
        kind: "command",
        run: `bun test packages/*/test/obligations/${c}.test.ts`,
      }),
    ),
  ];

  const task = BenchmarkTask.parse({
    schema_version: 1,
    // ULID → lowercase is within /^[a-z0-9][a-z0-9-]*$/ (Crockford base32).
    id: `session-${sessionId.toLowerCase()}`,
    statement,
    snapshot,
    checks,
    budget_ceiling_musd: Math.ceil(cost * 1.5),
    timeout_minutes: 30,
    declared_nondeterminism: [],
    session_command: null,
  });

  const dir = join(stagingSuiteDir, task.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.yaml"), Bun.YAML.stringify(task));
  return task;
};
