import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOARD = join(import.meta.dir, "board.mjs");

const sh = (cwd: string, cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
};
const git = (cwd: string, ...args: string[]) => {
  const r = sh(cwd, [
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    ...args,
  ]);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err}`);
  return r;
};
const board = (cwd: string, ...args: string[]) =>
  sh(cwd, ["bun", BOARD, ...args]);

const row = (id: string, status = "fixed", fix_commit: string | null = null) => ({
  id,
  task: "T",
  source: "verify",
  severity: "warning",
  clauses: [],
  summary: "s",
  root_cause: "design_bug",
  fix: "f",
  fix_commit,
  status,
});

const repo = (findings: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), "board-test-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, ".obligato"), { recursive: true });
  writeFileSync(
    join(dir, ".obligato", "findings.json"),
    JSON.stringify({ schema_version: 1, findings }, null, 2),
  );
  writeFileSync(
    join(dir, ".obligato", "tasks.json"),
    JSON.stringify({ schema_version: 1, tasks: [] }, null, 2),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
};

const findings = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".obligato", "findings.json"), "utf8")) as {
    findings: { id: string; fix_commit: string | null }[];
  };

describe("board.mjs stamp-head: id set-difference, never a diff-line heuristic", () => {
  it("stamps a row genuinely added in HEAD", () => {
    const dir = repo([row("F-001", "fixed", "oldsha")]);
    const d = findings(dir);
    d.findings.push(row("F-002"));
    writeFileSync(
      join(dir, ".obligato", "findings.json"),
      JSON.stringify({ schema_version: 1, ...d }, null, 2),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add F-002");
    const r = board(dir, "stamp-head");
    expect(r.code).toBe(0);
    expect(r.out).toContain("stamped F-002");
    const head = git(dir, "rev-parse", "HEAD").out.trim();
    expect(findings(dir).findings[1]?.fix_commit).toBe(head);
  });

  it("a rename commit (file at another path in HEAD~1) stamps nothing — F-174 class", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-test-"));
    git(dir, "init", "-q");
    mkdirSync(join(dir, ".oldname"), { recursive: true });
    writeFileSync(
      join(dir, ".oldname", "findings.json"),
      JSON.stringify({ schema_version: 1, findings: [row("F-001")] }, null, 2),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "old layout");
    mkdirSync(join(dir, ".obligato"), { recursive: true });
    git(dir, "mv", ".oldname/findings.json", ".obligato/findings.json");
    git(dir, "commit", "-qm", "rename");
    const r = board(dir, "stamp-head");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("stamped");
    expect(findings(dir).findings[0]?.fix_commit).toBeNull();
  });

  it("a rewrite that only reorders rows stamps nothing — F-169 class", () => {
    // The repositioned row is fixed+null — exactly the shape the old
    // added-line regex wrongly stamped (audit: the fixture must
    // discriminate; an open row is rejected by the status gate either way).
    const dir = repo([row("F-001", "fixed", "sha1"), row("F-002")]);
    const d = findings(dir);
    d.findings.reverse();
    writeFileSync(
      join(dir, ".obligato", "findings.json"),
      JSON.stringify({ schema_version: 1, ...d }, null, 2),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "reorder");
    const r = board(dir, "stamp-head");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("stamped");
    expect(
      findings(dir).findings.find((f) => f.id === "F-002")?.fix_commit,
    ).toBeNull();
  });

  it("a hostile ref name cannot execute through the numbering scan — F-182", () => {
    const dir = repo([row("F-001", "fixed", "sha1")]);
    // A VALID refname that is still shell-dangerous: git forbids spaces but
    // allows $ ( ) { }, so ${IFS} stands in for the space. Under the old
    // shell-string form this executed `touch`; the argv form cannot.
    git(dir, "update-ref", "refs/heads/a$(touch${IFS}OWNED)", "HEAD");
    const r = board(
      dir,
      "finding",
      JSON.stringify({
        task: "T",
        source: "verify",
        severity: "warning",
        summary: "s",
        root_cause: "design_bug",
        fix: "f",
      }),
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "OWNED"))).toBe(false);
  });
});

describe("board.mjs finding numbering scans ref tips — C1-21", () => {
  it("skips an id already allocated on another branch", () => {
    const dir = repo([row("F-001", "fixed", "sha1")]);
    git(dir, "checkout", "-qb", "side");
    const d = findings(dir);
    d.findings.push(row("F-002"));
    writeFileSync(
      join(dir, ".obligato", "findings.json"),
      JSON.stringify({ schema_version: 1, ...d }, null, 2),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "side allocates F-002");
    git(dir, "checkout", "-q", "-");
    const r = board(
      dir,
      "finding",
      JSON.stringify({
        task: "T",
        source: "verify",
        severity: "warning",
        summary: "s",
        root_cause: "design_bug",
        fix: "f",
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("F-003");
  });
});

describe("board.mjs retitle — C1-21/F-179", () => {
  it("retitles an active task and updates clauses; unknown id dies", () => {
    const dir = repo([]);
    board(dir, "task", "T-1", "open", "--title", "old name");
    const r = board(dir, "retitle", "T-1", "new name", "--clauses", "PERM-5");
    expect(r.code).toBe(0);
    expect(r.out).toContain('"old name" -> "new name"');
    const tasks = JSON.parse(
      readFileSync(join(dir, ".obligato", "tasks.json"), "utf8"),
    ) as { tasks: { id: string; title: string; clauses: string[] }[] };
    expect(tasks.tasks[0]?.title).toBe("new name");
    expect(tasks.tasks[0]?.clauses).toEqual(["PERM-5"]);
    const bad = board(dir, "retitle", "T-9", "x");
    expect(bad.code).toBe(1);
  });
});
