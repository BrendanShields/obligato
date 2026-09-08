import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, createAgentSession, forkSession } from "@obligato/agent";
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
import { INBOX_COLUMNS, INBOX_VIEW } from "../../src/commands/inbox.ts";
import { createUiServer } from "../../src/ui/server.ts";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

const LOCK = { schema_version: 1, parent_hash: null, entries: [] };
const LOCK_HASH = hashLockfile(LOCK);
const LONG_RATIONALE =
  "disable the pack because its TPAC regressed twelve percent on the seed suite";

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

const proposal = (
  db: Database,
  t: TestRepo,
  pack: string,
  rationale = `enable ${pack}`,
): string =>
  createProposal(db, {
    targetPack: pack,
    diff: { kind: "lockfile", ops: [{ op: "enable", pack }] },
    evidence: [evidenceLink(db)],
    rationale,
    createdBy: "human",
    repoRoot: t.repo,
    rejectionsSeenThrough: null,
  }).id;

const toApproved = (db: Database, id: string): void => {
  transition(db, id, "gated", { actor: "auto" });
  transition(db, id, "approved", { actor: "human", reason: "fixture" });
};

const toMonitoring = (db: Database, id: string): void => {
  toApproved(db, id);
  transition(db, id, "applied", { actor: "human" });
  transition(db, id, "monitoring", { actor: "auto" });
};

const session = (db: Database, t: TestRepo): string =>
  startSession(db, {
    repo: t.repo,
    lockfile_hash: LOCK_HASH,
    harness_version: "0.0.1",
    runner: "native",
  });

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

// A native session whose head chain ends in an unanswered ask; the user
// event id is returned so a fork can rewind past the ask (SES-6).
const nativeSession = (
  db: Database,
  t: TestRepo,
): { sessionId: string; userId: string } => {
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
  return { sessionId: s.sessionId, userId: user.id };
};

interface Seeded {
  // Every positive id with the exact verb the clause pins for it.
  expected: { kind: InboxItem["kind"]; id: string; verb: string }[];
  absent: string[];
  olderDivergence: string;
  longSummaryId: string;
}

// Every positive kind at least once, plus one discriminating negative per
// predicate.
const seed = (db: Database, t: TestRepo): Seeded => {
  const expected: Seeded["expected"] = [];
  const absent: string[] = [];
  const push = (kind: InboxItem["kind"], id: string, verb: string) =>
    expected.push({ kind, id, verb });

  const gated = proposal(db, t, "pack-gated", LONG_RATIONALE);
  transition(db, gated, "gated", { actor: "auto" });
  push("proposal_review", gated, `obligato loop review ${gated}`);
  const proposed = proposal(db, t, "pack-proposed");
  push("proposal_review", proposed, `obligato loop gate ${proposed}`);
  const approved = proposal(db, t, "pack-approved");
  toApproved(db, approved);
  push("proposal_review", approved, `obligato loop apply ${approved}`);
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
  push("auto_revert", autoReverted, `obligato loop release ${autoReverted}`);
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
  push("divergence", older, `obligato divergence show ${older}`);
  push("divergence", newer, `obligato divergence show ${newer}`);
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
  push("drift", "drift", "obligato drift list");

  const pausedBudget = session(db, t);
  budgetPause(db, pausedBudget);
  push("budget_pause", pausedBudget, `obligato session tree ${pausedBudget}`);
  const blockedBudget = session(db, t);
  budgetPause(db, blockedBudget).resolve("block", "auto", "budget_cap");
  push("budget_pause", blockedBudget, `obligato session tree ${blockedBudget}`);
  const continued = session(db, t);
  budgetPause(db, continued).resolve("continue", "human", "fixture");
  absent.push(continued);
  const escalated = session(db, t);
  budgetPause(db, escalated).resolve("escalate", "auto", "headless_default");
  absent.push(escalated);
  const respecced = session(db, t);
  budgetPause(db, respecced).resolve("re_spec", "human", "fixture");
  absent.push(respecced);
  const notASession = ulid();
  budgetPause(db, notASession);
  absent.push(notASession);

  db.query(
    `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, quarantined, origin)
     VALUES ('flaky-1', 'seed', '1.0.0', 'snap', 'do x', '[]', 1, 1, 'seed'),
            ('steady-1', 'seed', '1.0.0', 'snap', 'do y', '[]', 1, 0, 'seed')`,
  ).run();
  push(
    "quarantined",
    "flaky-1",
    "obligato eval suite promote flaky-1 --suite <suite-dir>",
  );
  absent.push("steady-1");

  const paused = nativeSession(db, t);
  push(
    "paused_session",
    paused.sessionId,
    `obligato chat --continue ${paused.sessionId}`,
  );
  const answered = nativeSession(db, t);
  const request = db
    .query(
      "SELECT id FROM session_event WHERE session_id = ? AND kind = 'permission_request'",
    )
    .get(answered.sessionId) as { id: string };
  appendEvent(db, {
    session_id: answered.sessionId,
    parent_id: request.id,
    kind: "permission_decision",
    payload: { request_id: request.id, decision: "allow", tool: "bash" },
  });
  absent.push(answered.sessionId);
  const ended = nativeSession(db, t);
  endSession(db, ended.sessionId);
  absent.push(ended.sessionId);
  // SES-6: forked before the ask — the head chain no longer reaches it.
  const forked = nativeSession(db, t);
  forkSession(db, forked.sessionId, forked.userId);
  absent.push(forked.sessionId);

  return { expected, absent, olderDivergence: older, longSummaryId: gated };
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

  it("seeded store: every positive with its pinned verb, negatives absent, order, 80-column rendering", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const db = openDb(dbPath);
    const s = seed(db, t);
    db.close();

    const r = await runCli(t, ["inbox", "--db", dbPath, "--json"]);
    expect(r.exitCode).toBe(0);
    const view = UiInboxView.parse(JSON.parse(r.stdout));
    // Exactly the seeded positives, nothing more.
    expect(view.items).toHaveLength(s.expected.length);
    for (const e of s.expected) {
      const item = view.items.find((i) => i.kind === e.kind && i.id === e.id);
      // revert-check: drop the verb's id interpolation for any kind (or
      // map `proposed`/`approved` to `review`) → that pinned verb differs.
      expect(item?.verb, `${e.kind} ${e.id}`).toBe(e.verb);
    }
    for (const kind of INBOX_KIND_ORDER)
      expect(
        view.items.some((i) => i.kind === kind),
        kind,
      ).toBe(true);
    expect(view.items.find((i) => i.kind === "drift")?.count).toBe(2);
    expect(
      view.items.find((i) => i.kind === "quarantined")?.age_seconds,
    ).toBeNull();
    const budgets = view.items.filter((i) => i.kind === "budget_pause");
    // revert-check: treat every triage_resolved as running → the blocked
    // session is absent and this length is 1.
    expect(budgets.map((b) => b.summary.split(" ")[1]).sort()).toEqual([
      "blocked",
      "paused",
    ]);
    // Discriminating negatives: every excluded row's id appears nowhere.
    // revert-check: widen the auto_revert predicate to any quarantined
    // proposal → the human-reverted id appears; derive paused_session
    // table-wide → the forked session appears.
    for (const id of s.absent)
      expect(
        view.items.some((i) => i.id === id),
        `${id} should be absent`,
      ).toBe(false);
    // Kind order pinned; within divergence the older report comes first
    // even though it was inserted second.
    const rank = view.items.map((i) => INBOX_KIND_ORDER.indexOf(i.kind));
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
    const divs = view.items.filter((i) => i.kind === "divergence");
    // revert-check: sort ascending by age → the newer report leads.
    expect(divs[0]?.id).toBe(s.olderDivergence);
    expect((divs[0]?.age_seconds ?? 0) > (divs[1]?.age_seconds ?? 0)).toBe(
      true,
    );

    // Rendering: every line fits 80 cells, the long-rationale summary is
    // clipped with …, every verb appears whole on its own line.
    const rendered = await runCli(t, ["inbox", "--db", dbPath]);
    expect(rendered.exitCode).toBe(0);
    const lines = rendered.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(view.items.length * 2);
    // revert-check: render the summary unclipped → the long-rationale line
    // exceeds 80 cells.
    for (const line of lines)
      expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(INBOX_COLUMNS);
    for (const i of view.items) expect(lines).toContain(`  ${i.verb}`);
    const long = view.items.find((i) => i.id === s.longSummaryId) as InboxItem;
    expect(long.summary.length).toBeGreaterThan(60);
    const longLine = lines.find((l) => l.includes("pack-gated")) as string;
    expect(longLine.endsWith("…")).toBe(true);
    expect(rendered.stdout).not.toContain(long.summary);

    // The web route is the same function on the same store (modulo clock).
    const server = createUiServer({ dbPath, port: 0 });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox`);
    expect(res.status).toBe(200);
    const web = UiInboxView.parse(await res.json());
    expect(stripAge(web.items)).toEqual(stripAge(view.items));
    // --json carries the untruncated summary.
    expect(web.items.find((i) => i.id === s.longSummaryId)?.summary).toBe(
      long.summary,
    );
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
