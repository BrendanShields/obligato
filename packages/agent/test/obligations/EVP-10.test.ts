import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { BenchmarkTask } from "@kelson/schemas";
import { promoteSession } from "../../src/promote.ts";
import { appendEvent, createAgentSession } from "../../src/sessions.ts";

// A minimal git repo so createAgentSession's storeSnapshot succeeds.
const gitRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-promote-")));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.io"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "f.txt"), "hi\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
};

describe("EVP-10: promote a session into a staging BenchmarkTask", () => {
  it("compiles statement, snapshot, checks, and budget×1.5 into a runnable task", () => {
    const repo = gitRepo();
    const store = realpathSync(mkdtempSync(join(tmpdir(), "kelson-snap-")));
    const db = openDb(":memory:");
    const { sessionId, rootEventId } = createAgentSession(db, {
      repo,
      lockfile_hash: "sha256:".padEnd(71, "0"),
      harness_version: "0.0.1",
      model: "m",
      system: "s",
      auth_kind: "none",
      snapshot_store_dir: store,
    });
    // First user message = the task statement.
    const u = appendEvent(db, {
      session_id: sessionId,
      parent_id: rootEventId,
      kind: "user_message",
      payload: { text: "add a sentinel to the file" },
    });
    // An assistant turn with a cost, then a touched-clause check — kept on the
    // same chain (each parented at the prior event, not root).
    const a = appendEvent(db, {
      session_id: sessionId,
      parent_id: u.id,
      kind: "assistant_message",
      payload: { text: "done", tool_calls: [], cost_micro_usd: 2000 },
    });
    appendEvent(db, {
      session_id: sessionId,
      parent_id: a.id,
      kind: "session_meta",
      payload: {
        obligation_check: {
          clause_id: "AGT-7",
          files_hash: "x",
          status: "pass",
          obligation_path: null,
        },
      },
    });

    const suiteDir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-suite-")));
    const task = promoteSession(db, sessionId, suiteDir);

    expect(task.statement).toBe("add a sentinel to the file");
    expect(task.snapshot).toMatch(/^sha256:/);
    expect(task.budget_ceiling_musd).toBe(3000); // 2000 × 1.5
    expect(task.checks.some((c) => c.kind === "obligations")).toBe(true);
    expect(
      task.checks.some((c) => c.kind === "command" && c.run.includes("AGT-7")),
    ).toBe(true);
    // Landed on disk and re-parses as a valid BenchmarkTask.
    const path = join(suiteDir, task.id, "task.yaml");
    expect(existsSync(path)).toBe(true);
    const reparsed = BenchmarkTask.parse(
      Bun.YAML.parse(require("node:fs").readFileSync(path, "utf8")),
    );
    expect(reparsed.id).toBe(task.id);
  });

  it("a session with no snapshot errors and writes no task", () => {
    const db = openDb(":memory:");
    // repo = a non-git string → storeSnapshot fails → snapshot null.
    const { sessionId, rootEventId } = createAgentSession(db, {
      repo: "not-a-git-repo",
      lockfile_hash: "sha256:".padEnd(71, "0"),
      harness_version: "0.0.1",
      model: "m",
      system: "s",
      auth_kind: "none",
    });
    appendEvent(db, {
      session_id: sessionId,
      parent_id: rootEventId,
      kind: "user_message",
      payload: { text: "hi" },
    });
    const suiteDir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-suite-")));
    expect(() => promoteSession(db, sessionId, suiteDir)).toThrow(/snapshot/);
  });
});
