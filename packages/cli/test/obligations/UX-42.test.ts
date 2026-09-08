import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, createAgentSession } from "@obligato/agent";
import {
  BudgetMonitor,
  createProposal,
  endSession,
  hashLockfile,
  INBOX_KIND_ORDER,
  inboxView,
  ingestStepEvent,
  openDb,
  recordDivergence,
  registerArtifact,
  revertProposal,
  startSession,
  transition,
  ulid,
} from "@obligato/kernel";
import { type InboxItem, UiInboxView } from "@obligato/schemas";
import { INBOX_VIEW } from "../../src/commands/inbox.ts";
import { createUiServer } from "../../src/ui/server.ts";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

const LOCK = { schema_version: 1, parent_hash: null, entries: [] };
const LOCK_HASH = hashLockfile(LOCK);

// One resolvable evidence link per proposal — createProposal refuses
// unresolvable links (LOOP-8), so the step_event row is seeded first.
const evidenceLink = (db: Database): string => {
  const id = ulid();
  ingestStepEvent(db, {
    id,
    task_id: ulid(),
    session_id: ulid(),
    sdlc_step: "build",
    model: "m",
    effort: "medium",
    agent_id: "a",
    tokens_in: 1,
    tokens_out: 1,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    unit_prices: {},
    cost_micro_usd: 0,
    budget_tokens: 1,
    overrun: "none",
    span_id: null,
    schema_version: 1,
  });
  return `ev:db/step_event/${id}`;
};

const proposal = (db: Database, t: TestRepo, pack: string): string =>
  createProposal(db, {
    targetPack: pack,
    diff: { kind: "lockfile", ops: [{ op: "enable", pack }] },
    evidence: [evidenceLink(db)],
    rationale: `enable ${pack}`,
    createdBy: "human",
    repoRoot: t.repo,
    rejectionsSeenThrough: null,
  }).id;

const toMonitoring = (db: Database, id: string): void => {
  transition(db, id, "gated", { actor: "auto" });
  transition(db, id, "approved", { actor: "human", reason: "fixture" });
  transition(db, id, "applied", { actor: "human" });
  transition(db, id, "monitoring", { actor: "auto" });
};

const budgetPause = (db: Database, stepId: string): BudgetMonitor => {
  const m = new BudgetMonitor(db, {
    taskId: stepId,
    stepId,
    attempt: 0,
    ruleId: "session",
    policyHash: `sha256:${"0".repeat(64)}`,
    modelId: "m",
    escalationDepth: 0,
    budgetTokens: 10,
  });
  expect(m.record(20)).toBe("paused");
  return m;
};

const nativeSession = (db: Database, t: TestRepo): string => {
  const s = createAgentSession(db, {
    repo: t.repo,
    lockfile_hash: LOCK_HASH,
    harness_version: "0.0.1",
    model: "mock-m",
    system: "s",
    auth_kind: "none",
  });
  const user = appendEvent(db, {
    session_id: s.sessionId,
    parent_id: s.rootEventId,
    kind: "user_message",
    payload: { text: "rm it" },
  });
  const asst = appendEvent(db, {
    session_id: s.sessionId,
    parent_id: user.id,
    kind: "assistant_message",
    payload: {
      text: "",
      tool_calls: [{ id: `${s.sessionId}-c0`, name: "bash", input: {} }],
    },
  });
  appendEvent(db, {
    session_id: s.sessionId,
    parent_id: asst.id,
    kind: "permission_request",
    payload: {
      tool_call_id: `${s.sessionId}-c0`,
      tool: "bash",
      arg: "rm -rf build",
      rule: "default",
      reason: "permission:bash",
    },
  });
  return s.sessionId;
};

interface Seeded {
  ids: Record<InboxItem["kind"], string>;
  absent: string[];
  olderDivergence: string;
}

// Every positive kind once, plus one discriminating negative per predicate.
const seed = (db: Database, t: TestRepo): Seeded => {
  const absent: string[] = [];
  const gated = proposal(db, t, "pack-gated");
  transition(db, gated, "gated", { actor: "auto" });
  const rejected = proposal(db, t, "pack-rejected");
  transition(db, rejected, "gated", { actor: "auto" });
  transition(db, rejected, "rejected", { actor: "human", reason: "no" });
  absent.push(rejected);

  const ctx = {
    lockfilePath: join(t.repo, "obligato.lock"),
    changelogPath: join(t.repo, ".obligato", "changelog.jsonl"),
  };
  const autoReverted = proposal(db, t, "pack-auto");
  toMonitoring(db, autoReverted);
  revertProposal(db, autoReverted, ctx, {
    actor: "auto",
    reason: "LOOP-3 regression auto-revert",
  });
  const humanReverted = proposal(db, t, "pack-human");
  toMonitoring(db, humanReverted);
  revertProposal(db, humanReverted, ctx, {
    actor: "human",
    reason: "human revert",
  });
  absent.push(humanReverted);

  const entry = {
    clause_id: "X-1",
    probe_input: {},
    differing_path: "$.v",
    outcome_a: { tag: "returned" as const, value: { v: 1 } },
    outcome_b: { tag: "returned" as const, value: { v: 2 } },
    redacted_paths: [],
  };
  const div = (clause: string) =>
    recordDivergence(db, `spec ${clause}`, {
      status: "diverged",
      seed: 1,
      entries: [{ ...entry, clause_id: clause }],
    });
  // newer inserted FIRST so "older first" is discriminating against rowid.
  const newer = div("X-2");
  const older = div("X-1");
  db.query("UPDATE divergence_report SET at = ? WHERE id = ?").run(
    "2026-06-01T00:00:00Z",
    newer,
  );
  db.query("UPDATE divergence_report SET at = ? WHERE id = ?").run(
    "2026-01-01T00:00:00Z",
    older,
  );
  const resolved = div("X-3");
  db.query("UPDATE divergence_report SET resolved = 1 WHERE id = ?").run(
    resolved,
  );
  absent.push(resolved);

  registerArtifact(db, {
    repo: "r",
    logical_id: "m/a.ts",
    type: "code_region",
    content: "a",
    authority: "authored",
  });
  const drift = (id: string, resolution: string) =>
    db
      .query(
        `INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, resolution, schema_version)
         VALUES (?, 'r', 'm/a.ts', 'spec_over_code', ?, ?, 1)`,
      )
      .run(id, "2026-03-01T00:00:00Z", resolution);
  drift("drift-open-1", "open");
  drift("drift-open-2", "open");
  drift("drift-repaired", "repaired");
  absent.push("drift-repaired");

  const pausedBudget = startSession(db, {
    repo: t.repo,
    lockfile_hash: LOCK_HASH,
    harness_version: "0.0.1",
    runner: "native",
  });
  budgetPause(db, pausedBudget);
  const continued = startSession(db, {
    repo: t.repo,
    lockfile_hash: LOCK_HASH,
    harness_version: "0.0.1",
    runner: "native",
  });
  budgetPause(db, continued).resolve("continue", "human", "fixture");
  absent.push(continued);
  const notASession = ulid();
  budgetPause(db, notASession);
  absent.push(notASession);

  db.query(
    `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, quarantined, origin)
     VALUES ('flaky-1', 'seed', '1.0.0', 'snap', 'do x', '[]', 1, 1, 'seed'),
            ('steady-1', 'seed', '1.0.0', 'snap', 'do y', '[]', 1, 0, 'seed')`,
  ).run();
  absent.push("steady-1");

  const paused = nativeSession(db, t);
  const answered = nativeSession(db, t);
  const request = db
    .query(
      "SELECT id FROM session_event WHERE session_id = ? AND kind = 'permission_request'",
    )
    .get(answered) as { id: string };
  appendEvent(db, {
    session_id: answered,
    parent_id: request.id,
    kind: "permission_decision",
    payload: { request_id: request.id, decision: "allow", tool: "bash" },
  });
  absent.push(answered);
  const ended = nativeSession(db, t);
  endSession(db, ended);
  absent.push(ended);

  return {
    ids: {
      proposal_review: gated,
      divergence: older,
      drift: "drift",
      budget_pause: pausedBudget,
      auto_revert: autoReverted,
      quarantined: "flaky-1",
      paused_session: paused,
    },
    absent,
    olderDivergence: older,
  };
};

const stripAge = (items: InboxItem[]) =>
  items.map(({ age_seconds: _age, ...rest }) => rest);

const servers: { stop: (force: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

describe("UX-42: obligato inbox — one kernel view, one verb per item, pinned predicates and order", () => {
  it("the CLI/launcher read path is the exported kernel view (F-085 identity)", () => {
    // revert-check: reimplement the query in inbox.ts → this reference check fails.
    expect(INBOX_VIEW).toBe(inboxView);
  });

  it("seeded store: one item per kind, verbs name ids, negatives absent, older-first, table names every row", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const db = openDb(dbPath);
    const s = seed(db, t);
    db.close();

    const r = await runCli(t, ["inbox", "--db", dbPath, "--json"]);
    expect(r.exitCode).toBe(0);
    const view = UiInboxView.parse(JSON.parse(r.stdout));
    // First item per kind — for divergence that is the OLDER report (order).
    const byKind = new Map<InboxItem["kind"], InboxItem>();
    for (const i of view.items) if (!byKind.has(i.kind)) byKind.set(i.kind, i);
    // Exactly one item per kind, except the two seeded unresolved divergences.
    expect(view.items.filter((i) => i.kind !== "divergence")).toHaveLength(6);
    expect(view.items.filter((i) => i.kind === "divergence")).toHaveLength(2);
    for (const kind of INBOX_KIND_ORDER) {
      const item = byKind.get(kind);
      expect(item, kind).toBeDefined();
      // revert-check: drop the verb's id interpolation for any kind → that
      // kind's verb no longer names its id and this assertion fails.
      expect(item?.verb.startsWith("obligato ")).toBe(true);
      if (kind === "drift") expect(item?.verb).toBe("obligato drift list");
      else expect(item?.verb).toContain(s.ids[kind]);
      expect(item?.id).toBe(s.ids[kind]);
    }
    expect(byKind.get("proposal_review")?.verb).toBe(
      `obligato loop review ${s.ids.proposal_review}`,
    );
    expect(byKind.get("auto_revert")?.verb).toBe(
      `obligato loop release ${s.ids.auto_revert}`,
    );
    expect(byKind.get("drift")?.count).toBe(2);
    expect(byKind.get("quarantined")?.age_seconds).toBeNull();
    expect(byKind.get("budget_pause")?.summary).toContain("paused");
    // Discriminating negatives: every excluded row's id appears nowhere.
    // revert-check: widen the auto_revert predicate to any quarantined
    // proposal → the human-reverted id appears and this fails.
    for (const id of s.absent)
      expect(
        view.items.some((i) => i.id === id),
        `${id} should be absent`,
      ).toBe(false);
    // Kind order pinned; within divergence the older report comes first
    // even though it was inserted second.
    const kinds = view.items.map((i) => i.kind);
    const rank = kinds.map((k) => INBOX_KIND_ORDER.indexOf(k));
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
    const divs = view.items.filter((i) => i.kind === "divergence");
    // revert-check: sort ascending by age → the newer report leads.
    expect(divs[0]?.id).toBe(s.olderDivergence);
    expect((divs[0]?.age_seconds ?? 0) > (divs[1]?.age_seconds ?? 0)).toBe(
      true,
    );

    const table = await runCli(t, ["inbox", "--db", dbPath]);
    expect(table.exitCode).toBe(0);
    for (const i of view.items) {
      expect(table.stdout).toContain(i.summary);
      expect(table.stdout).toContain(i.verb);
    }

    // The web route is the same function on the same store (modulo clock).
    const server = createUiServer({ dbPath, port: 0 });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox`);
    expect(res.status).toBe(200);
    const web = UiInboxView.parse(await res.json());
    expect(stripAge(web.items)).toEqual(stripAge(view.items));
  });

  it("empty and missing stores: one line naming the verb, and no store file is created", async () => {
    const t = makeTestRepo({});
    const missing = join(t.repo, "missing.db");
    const r = await runCli(t, ["inbox", "--db", missing]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("inbox empty — obligato loop propose");
    // revert-check: read through openDb unconditionally → the file is
    // migrated into existence and this assertion fails.
    expect(existsSync(missing)).toBe(false);
    // Default resolution (no --db, temp HOME, no repo store) is the same line.
    const d = await runCli(t, ["inbox"]);
    expect(d.stdout.trim()).toBe("inbox empty — obligato loop propose");
    const j = await runCli(t, ["inbox", "--json"]);
    expect(UiInboxView.parse(JSON.parse(j.stdout))).toEqual({
      empty_verb: "obligato loop propose",
      items: [],
    });
  });

  it("the view refuses a non-ISO clock", () => {
    const t = makeTestRepo({});
    const db = openDb(join(t.repo, ".obligato", "obligato.db"));
    expect(() => inboxView(db, "yesterday")).toThrow(/ISO-8601/);
    db.close();
  });
});
