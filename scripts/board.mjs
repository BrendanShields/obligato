#!/usr/bin/env bun
// Owns .obligato/tasks.json and .obligato/findings.json edits: validates shape,
// stamps timestamps, auto-numbers finding IDs. Hand-editing these files is
// how keys drift (postmortem lesson: 6 ad-hoc heredocs in one session).
//
//   bun scripts/board.mjs task <id> <open|in_progress|completed> [--note "..."] [--clauses TEL-1,ART-2]
//   bun scripts/board.mjs finding '<json>'     # id/status/fix_commit optional; id auto-numbers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";

const TASKS = ".obligato/tasks.json";
const FINDINGS = ".obligato/findings.json";
const TASKS_ARCHIVE = ".obligato/archive/tasks.json";
const FINDINGS_ARCHIVE = ".obligato/archive/findings.json";
const TASK_STATES = ["open", "in_progress", "completed"];
const FINDING_KEYS = [
  "id",
  "task",
  "source",
  "severity",
  "clauses",
  "summary",
  "root_cause",
  "fix",
  "fix_commit",
  "status",
];

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, d) => writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
const die = (msg) => {
  console.error(`board: ${msg}`);
  process.exit(1);
};

const [mode, ...rest] = process.argv.slice(2);

if (mode === "task") {
  const [id, state] = rest;
  if (!TASK_STATES.includes(state))
    die(`state must be one of ${TASK_STATES.join("|")}`);
  const d = load(TASKS);
  let task = d.tasks.find((t) => t.id === id);
  // create-collision guard (2026-07-10: an archived-era completed C1-11 got
  // silently revived by a create attempt): --title means "new task", so an
  // existing id — active OR archived — is an error, and the archive must be
  // consulted since ids are hand-assigned against the full history.
  const titleIdx = rest.indexOf("--title");
  if (titleIdx !== -1) {
    const archivedTask =
      !task && existsSync(TASKS_ARCHIVE)
        ? load(TASKS_ARCHIVE).tasks.find((t) => t.id === id)
        : null;
    if (task || archivedTask)
      die(
        `task ${id} already exists${archivedTask ? " (archived)" : ""}: "${(task ?? archivedTask).title}" — pick a free id or drop --title to update it`,
      );
  }
  if (!task) {
    if (titleIdx === -1)
      die(`unknown task ${id} (have: ${d.tasks.map((t) => t.id).join(", ")}); pass --title to create`);
    task = { id, title: rest[titleIdx + 1], state, clauses: [], completed_at: null };
    d.tasks.push(task);
  }
  task.state = state;
  // re-marking an already-completed task must not falsify its history
  task.completed_at =
    state === "completed"
      ? (task.completed_at ?? `${new Date().toISOString().slice(0, 19)}Z`)
      : null;
  const noteIdx = rest.indexOf("--note");
  if (noteIdx !== -1) task.notes = rest[noteIdx + 1];
  const clausesIdx = rest.indexOf("--clauses");
  // "" means no clauses -> [], never [""] (F-audit 2026-07-05)
  if (clausesIdx !== -1)
    task.clauses = rest[clausesIdx + 1] ? rest[clausesIdx + 1].split(",") : [];
  save(TASKS, d);
  console.log(`${id} -> ${state}`);
} else if (mode === "finding") {
  const d = load(FINDINGS);
  // Flag form (postmortem 2026-07-05: inline JSON in shell is an escaping
  // hazard — apostrophes bit three times in one session):
  //   board.mjs finding --task C1-1 --severity warning --clauses A,B \
  //     --root-cause design_bug --summary "..." --fix "..." [--source s]
  let row;
  if ((rest[0] ?? "").startsWith("--")) {
    row = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]?.slice(2).replaceAll("-", "_");
      const val = rest[i + 1];
      if (!key || val === undefined) die(`flag ${rest[i]} needs a value`);
      row[key] = key === "clauses" ? (val ? val.split(",") : []) : val;
    }
    row.source ??= "clause-auditor";
  } else {
    row = JSON.parse(rest[0] ?? die("finding requires a JSON argument or flags"));
  }
  // taxonomy is an object (slug -> description); Object.keys, not .length/.includes
  const taxonomy = Object.keys(d.root_cause_taxonomy ?? {});
  if (taxonomy.length && !taxonomy.includes(row.root_cause))
    die(`root_cause must be one of: ${taxonomy.join(", ")}`);
  if (!["violation", "warning"].includes(row.severity))
    die("severity must be violation|warning");
  // numbering spans active + archive — archiving must never recycle an id —
  // PLUS every local/remote ref tip: parallel branches otherwise allocate the
  // same next id (F-177 collided with an open PR's F-173, C1-21). Ref scan is
  // best-effort; a failure falls back to the local files.
  const archived = existsSync(FINDINGS_ARCHIVE)
    ? load(FINDINGS_ARCHIVE).findings
    : [];
  const refIds = () => {
    // argv form throughout — a fetched ref NAME is attacker-controllable and
    // may contain $(...);| etc.; a shell string here executed it (F-182,
    // audit-reproduced). No shell, ever, for anything carrying a refname.
    // ponytail: O(refs) subprocess spawns; cap/single-pass if a many-remote
    // repo ever makes this noticeable.
    try {
      const refs = execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      const out = [];
      for (const ref of refs)
        for (const p of [FINDINGS, FINDINGS_ARCHIVE])
          try {
            out.push(
              ...JSON.parse(
                execFileSync("git", ["show", `${ref}:${p}`], {
                  stdio: ["ignore", "pipe", "ignore"],
                }).toString(),
              ).findings.map((f) => f.id),
            );
          } catch {}
      return out;
    } catch {
      return [];
    }
  };
  const next =
    Math.max(
      0,
      ...[...d.findings, ...archived]
        .map((f) => f.id)
        .concat(row.id === undefined ? refIds() : [])
        .map((id) => Number(id.slice(2)) || 0),
    ) + 1;
  row.id ??= `F-${String(next).padStart(3, "0")}`;
  row.status ??= "fixed";
  row.clauses ??= [];
  row.fix_commit ??= null; // not-yet-committed findings are stamped later
  const unknown = Object.keys(row).filter((k) => !FINDING_KEYS.includes(k));
  const missing = FINDING_KEYS.filter((k) => !(k in row));
  if (unknown.length) die(`unknown keys: ${unknown.join(", ")}`);
  if (missing.length) die(`missing keys: ${missing.join(", ")}`);
  d.findings.push(row);
  save(FINDINGS, d);
  console.log(row.id);
} else if (mode === "stamp") {
  // Explicitly named ids are operator intent: overwrite (that is how a
  // mis-stamp gets corrected — F-175: the old null-guard silently kept six
  // wrong shas while printing success). Report old -> new per correction,
  // then verify the write landed (scripted edits assert their own effect).
  const [sha, ...ids] = rest;
  if (!sha || ids.length === 0) die("usage: board.mjs stamp <sha> <F-ID...>");
  const d = load(FINDINGS);
  const missing = ids.filter((id) => !d.findings.some((f) => f.id === id));
  if (missing.length) die(`unknown finding ids: ${missing.join(", ")}`);
  for (const f of d.findings)
    if (ids.includes(f.id)) {
      if (f.fix_commit !== null && f.fix_commit !== sha)
        console.log(`${f.id}: correcting ${f.fix_commit} -> ${sha}`);
      f.fix_commit = sha;
    }
  save(FINDINGS, d);
  const check = load(FINDINGS).findings.filter(
    (f) => ids.includes(f.id) && f.fix_commit !== sha,
  );
  if (check.length)
    die(`stamp did not land for: ${check.map((f) => f.id).join(", ")}`);
  console.log(`stamped ${ids.join(", ")} -> ${sha}`);
} else if (mode === "stamp-head") {
  // Post-commit auto-stamp (postmortem 2026-07-09: 25 rows shipped fix_commit
  // null because the manual stamp step was always forgotten). Stamps rows
  // ADDED in HEAD, computed as an id SET DIFFERENCE between HEAD and HEAD~1 —
  // never a diff-line heuristic: a rename or rewrite keeps the id set
  // identical, so nothing reads as new (F-169 archive rewrite, F-174 rename
  // both mis-stamped under the old added-line regex). The stamped file rides
  // along in the next commit — never amends, so no hook recursion.
  let sha;
  let prevIds;
  let headRows;
  try {
    sha = execSync("git rev-parse HEAD").toString().trim();
    headRows = JSON.parse(
      execSync(`git show HEAD:${FINDINGS}`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    ).findings;
    prevIds = new Set(
      JSON.parse(
        execSync(`git show HEAD~1:${FINDINGS}`, {
          stdio: ["ignore", "pipe", "ignore"],
        }).toString(),
      ).findings.map((f) => f.id),
    );
  } catch {
    // Initial commit, no git, or the file lived at another path in HEAD~1
    // (a rename commit): no reliable baseline — stamp nothing (fail-safe;
    // an explicit `board.mjs stamp` remains the correction path).
    process.exit(0);
  }
  const added = headRows.map((f) => f.id).filter((id) => !prevIds.has(id));
  const d = load(FINDINGS);
  // status gate (F-096): only "fixed" rows are stampable, whatever "added" says.
  const stamped = d.findings.filter(
    (f) =>
      added.includes(f.id) && f.fix_commit === null && f.status === "fixed",
  );
  if (stamped.length === 0) process.exit(0);
  for (const f of stamped) f.fix_commit = sha;
  save(FINDINGS, d);
  console.log(
    `stamped ${stamped.map((f) => f.id).join(", ")} -> ${sha} (findings.json modified; include in next commit)`,
  );
} else if (mode === "retitle") {
  // Retitle/re-clause an ACTIVE task without the task-mode create guard
  // (F-179: --title on an existing id is refused by design, so title fixes
  // had no tool path and fell back to hand edits).
  const [id, title] = rest;
  if (!id || !title)
    die('usage: board.mjs retitle <id> "<title>" [--clauses a,b]');
  const d = load(TASKS);
  const task = d.tasks.find((t) => t.id === id);
  if (!task) die(`unknown active task ${id} — retitle edits active tasks only`);
  const before = task.title;
  task.title = title;
  const clausesIdx = rest.indexOf("--clauses");
  if (clausesIdx !== -1)
    task.clauses = rest[clausesIdx + 1] ? rest[clausesIdx + 1].split(",") : [];
  save(TASKS, d);
  const check = load(TASKS).tasks.find((t) => t.id === id);
  if (check?.title !== title) die("retitle did not land");
  console.log(`${id}: "${before}" -> "${title}"`);
} else if (mode === "archive") {
  // Closed rows dominate the active files (98% at 2026-07-10: ~30k tokens per
  // full read) — move them under .obligato/archive/. fixed-but-unstamped
  // findings stay active (stamp/stamp-head only see the active file);
  // open/deferred stay by definition. Miners read both files.
  mkdirSync(".obligato/archive", { recursive: true });
  const loadOr = (p, empty) => (existsSync(p) ? load(p) : empty);

  const t = load(TASKS);
  const ta = loadOr(TASKS_ARCHIVE, {
    schema_version: t.schema_version,
    tasks: [],
  });
  const doneTasks = t.tasks.filter((x) => x.state === "completed");
  ta.tasks.push(...doneTasks);
  t.tasks = t.tasks.filter((x) => x.state !== "completed");
  save(TASKS_ARCHIVE, ta);
  save(TASKS, t);

  const f = load(FINDINGS);
  const fa = loadOr(FINDINGS_ARCHIVE, {
    schema_version: f.schema_version,
    findings: [],
  });
  const closed = f.findings.filter(
    (x) =>
      x.status === "resolved" ||
      (x.status === "fixed" && x.fix_commit !== null),
  );
  fa.findings.push(...closed);
  f.findings = f.findings.filter((x) => !closed.includes(x));
  save(FINDINGS_ARCHIVE, fa);
  save(FINDINGS, f);
  console.log(
    `archived ${doneTasks.length} tasks, ${closed.length} findings -> .obligato/archive/`,
  );
} else {
  die("usage: board.mjs task <id> <state> [--note ...] [--clauses a,b] | board.mjs retitle <id> \"<title>\" [--clauses a,b] | board.mjs finding '<json>' | board.mjs stamp <sha> <F-ID...> | board.mjs stamp-head | board.mjs archive");
}
