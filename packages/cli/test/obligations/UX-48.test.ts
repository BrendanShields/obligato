import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession } from "@obligato/agent";
import { ingestStepEvent, openDb, ulid } from "@obligato/kernel";
import { SessionListResult } from "@obligato/schemas";
import { createChat, slashTargets, update } from "../../src/chat/model.ts";
import { COMMANDS } from "../../src/index.ts";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const seedSession = (db: ReturnType<typeof openDb>, cost: number | null) => {
  const s = createAgentSession(db, {
    repo: "test-repo",
    lockfile_hash: "sha256:".padEnd(71, "0"),
    harness_version: "0.0.1",
    model: "mock-m",
    system: "sys",
    auth_kind: "none",
  });
  ingestStepEvent(db, {
    id: ulid(),
    task_id: s.taskId,
    session_id: s.sessionId,
    sdlc_step: "build",
    model: "mock-m",
    effort: "medium",
    agent_id: "native",
    tokens_in: 10,
    tokens_out: 5,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    unit_prices: {},
    cost_micro_usd: cost,
    budget_tokens: 1000,
    overrun: "none",
    span_id: null,
    schema_version: 1,
  });
  return s.sessionId;
};

describe("UX-48: session slash commands dispatch to the one session function; `session list`", () => {
  it("identity: /fork /compact /compare /sessions all resolve to COMMANDS.session", () => {
    const targets = slashTargets(COMMANDS);
    // revert-check: map the slashes to a wrapper closure → toBe fails.
    for (const slash of ["/fork", "/compact", "/compare", "/sessions"])
      expect(targets[slash]).toBe(COMMANDS.session as never);
  });

  it("reducer: argv built from meta.sessionId per slash", () => {
    const known = ["/fork", "/compact", "/compare", "/sessions"];
    const m = createChat("mock-m", { sessionId: "S" }, known);
    const argv = (text: string) => update(m, { type: "submit", text }).effects;
    expect(argv("/fork e1")).toEqual([
      { type: "dispatch", command: "fork", argv: ["fork", "S", "e1"] },
    ]);
    expect(argv("/compact")).toEqual([
      { type: "dispatch", command: "compact", argv: ["compact", "S"] },
    ]);
    expect(argv("/compare a b")).toEqual([
      {
        type: "dispatch",
        command: "compare",
        argv: ["compare", "S", "a", "b"],
      },
    ]);
    // revert-check: pass args through untouched → ["--limit","5"] lacks "list".
    expect(argv("/sessions --limit 5")).toEqual([
      { type: "dispatch", command: "sessions", argv: ["list", "--limit", "5"] },
    ]);
  });

  it("CLI: `session list` newest first, n/a for an unpriced cost, --json validates, --limit bounds", async () => {
    const t = makeTestRepo({});
    mkdirSync(join(t.home, "store"), { recursive: true });
    const dbPath = join(t.home, "store", "list.sqlite");
    const db = openDb(dbPath);
    const older = seedSession(db, 10_000);
    const newer = seedSession(db, null);
    db.close();

    const r = await runCli(t, ["session", "list", "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    const newerLine = lines.findIndex((l) => l.startsWith(newer));
    const olderLine = lines.findIndex((l) => l.startsWith(older));
    expect(newerLine).toBeGreaterThan(1);
    // revert-check: order by rowid ASC → the older row comes first.
    expect(newerLine).toBeLessThan(olderLine);
    expect(lines[newerLine]).toContain("n/a");
    expect(lines[olderLine]).toContain("$0.0100");

    const j = await runCli(t, ["session", "list", "--db", dbPath, "--json"]);
    // Verification independence: the schema call is the test's own.
    const parsed = SessionListResult.parse(JSON.parse(j.stdout));
    expect(parsed.sessions.map((s) => s.id)).toEqual([newer, older]);
    expect(parsed.sessions[0]?.cost_micro_usd).toBeNull();
    expect(parsed.sessions[1]?.cost_micro_usd).toBe(10_000);
    expect(parsed.sessions[0]?.steps).toBe(1);

    const one = await runCli(t, [
      "session",
      "list",
      "--db",
      dbPath,
      "--json",
      "--limit",
      "1",
    ]);
    expect(
      SessionListResult.parse(JSON.parse(one.stdout)).sessions,
    ).toHaveLength(1);
  }, 20_000);
});
