import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../../src/context.ts";
import { localExec } from "../../src/tools.ts";

const IDENTITY = "You are a test agent with rules.";

const workspace = (opts: { git?: boolean } = {}): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-prompt-")));
  if (opts.git !== false) {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "seed.txt"), "s\n");
  }
  return dir;
};

const build = (dir: string): string =>
  buildSystemPrompt({ identity: IDENTITY, cwd: dir, exec: localExec(dir) });

describe("AGT-15: one system-prompt builder — identity + environment + conventions", () => {
  it("a git workspace with AGENTS.md composes all three parts", () => {
    const dir = workspace();
    writeFileSync(join(dir, "AGENTS.md"), "Always use tabs.\n");
    const p = build(dir);
    expect(p).toContain(IDENTITY);
    expect(p).toContain(`cwd: ${dir}`);
    expect(p).toContain(`platform: ${process.platform}`);
    expect(p).toMatch(/date: \d{4}-\d{2}-\d{2}/);
    expect(p).toContain("branch main");
    expect(p).toContain("Project conventions (AGENTS.md):");
    expect(p).toContain("Always use tabs.");
  });

  it("CLAUDE.md is used only when AGENTS.md is absent", () => {
    const dir = workspace();
    writeFileSync(join(dir, "CLAUDE.md"), "claude rules\n");
    expect(build(dir)).toContain("Project conventions (CLAUDE.md):");
    writeFileSync(join(dir, "AGENTS.md"), "agents rules\n");
    const p = build(dir);
    expect(p).toContain("agents rules");
    expect(p).not.toContain("claude rules");
  });

  it("an oversized conventions file truncates at the cap with the notice", () => {
    const dir = workspace();
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(9_000));
    const p = build(dir);
    expect(p).toContain("(truncated at 8000 characters)");
    expect(p).not.toContain("x".repeat(8_001));
  });

  it("a non-git workspace omits the git line and still composes", () => {
    const dir = workspace({ git: false });
    const p = build(dir);
    expect(p).toContain(`cwd: ${dir}`);
    expect(p).not.toContain("git: branch");
  });

  it("the CLI setup and the api executor invoke the same exported builder (F-085 identity)", async () => {
    const { PROMPT_BUILDER } = await import("../../../cli/src/agent/common.js");
    expect(PROMPT_BUILDER).toBe(buildSystemPrompt);
    // executor.ts imports buildSystemPrompt from the same module — a source
    // scan pins it to the shared symbol, not a copy.
    const src = await Bun.file(
      join(import.meta.dir, "..", "..", "src", "executor.ts"),
    ).text();
    expect(src).toContain("buildSystemPrompt({");
    expect(src).not.toContain('system:\n      "You are Kelson');
  });
});
