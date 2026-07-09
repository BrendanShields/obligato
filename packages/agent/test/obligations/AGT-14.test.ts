import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentTool,
  CORE_TOOLS,
  localExec,
  type ToolContext,
} from "../../src/tools.ts";

const grep = CORE_TOOLS.find((t) => t.name === "grep") as AgentTool;
const find = CORE_TOOLS.find((t) => t.name === "find") as AgentTool;

// A git repo with a .gitignore'd twin of a tracked file.
const repo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-rg-")));
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  writeFileSync(join(dir, "tracked.ts"), "const NEEDLE = 1;\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "ignored.ts"), "const NEEDLE = 2;\n");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

const withRg = (dir: string): ToolContext => ({
  cwd: dir,
  exec: localExec(dir),
});
// A no-rg PATH built by EXCLUDING the resolved rg directory — never
// hardcoded, so a runner with rg in /usr/bin still exercises the fallback
// (audit 2026-07-05).
const rgDir = (() => {
  const r = spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/\/rg\n?$/, "") : null;
})();
const noRgPath = (process.env.PATH ?? "/usr/bin:/bin")
  .split(":")
  .filter((p) => p !== rgDir)
  .join(":");
const withoutRg = (dir: string): ToolContext => ({
  cwd: dir,
  exec: (cmd, opts) =>
    localExec(dir)(cmd, { ...opts, env: { PATH: noRgPath } }),
});

const rgOnPath =
  spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).status === 0;

describe("AGT-14: ripgrep-preferred, gitignore-aware, capped search with preserved fallback", () => {
  it.if(rgOnPath)(
    "rg skips the .gitignore'd twin; the tracked file matches",
    () => {
      const dir = repo();
      const out = grep.run({ pattern: "NEEDLE" }, withRg(dir));
      expect(out).toContain("tracked.ts");
      expect(out).not.toContain("ignored.ts");
    },
  );

  it("the fallback (no rg on PATH) matches both — prior behavior preserved", () => {
    const dir = repo();
    const out = grep.run({ pattern: "NEEDLE" }, withoutRg(dir));
    expect(out).toContain("tracked.ts");
    expect(out).toContain("dist/ignored.ts");
  });

  it.if(rgOnPath)("find prefers rg --files and skips ignored files", () => {
    const dir = repo();
    const out = find.run({ pattern: "*.ts" }, withRg(dir));
    expect(out).toContain("tracked.ts");
    expect(out).not.toContain("ignored.ts");
  });

  it("find fallback still prunes only .git/node_modules", () => {
    const dir = repo();
    const out = find.run({ pattern: "*.ts" }, withoutRg(dir));
    expect(out).toContain("tracked.ts");
    expect(out).toContain("ignored.ts");
  });

  it("a >200-line result carries the explicit cap notice", () => {
    const dir = repo();
    writeFileSync(
      join(dir, "big.txt"),
      Array.from({ length: 300 }, (_, i) => `NEEDLE line ${i}`).join("\n"),
    );
    const out = grep.run({ pattern: "NEEDLE" }, withRg(dir));
    expect(out).toContain("capped at 200 lines");
    expect(
      out.split("\n").filter((l) => l.includes("NEEDLE")).length,
    ).toBeLessThanOrEqual(200);
  });

  it.if(rgOnPath)("the glob parameter narrows matches under rg", () => {
    const dir = repo();
    writeFileSync(join(dir, "note.md"), "NEEDLE in markdown\n");
    const out = grep.run({ pattern: "NEEDLE", glob: "*.md" }, withRg(dir));
    expect(out).toContain("note.md");
    expect(out).not.toContain("tracked.ts");
  });

  it("the glob parameter under the fallback produces the explicit notice", () => {
    const dir = repo();
    const out = grep.run({ pattern: "NEEDLE", glob: "*.md" }, withoutRg(dir));
    expect(out).toContain("glob filter ignored: ripgrep not available");
  });

  it("an invalid regex surfaces exit 2 + stderr under both branches — never (no matches)", () => {
    const dir = repo();
    for (const ctx of [withRg(dir), withoutRg(dir)]) {
      const out = grep.run({ pattern: "unclosed[" }, ctx);
      expect(out).toContain("exit 2");
      expect(out).not.toContain("(no matches)");
    }
  });

  it("an exactly-200-line untruncated result carries no cap notice", () => {
    const dir = repo();
    writeFileSync(
      join(dir, "exact.txt"),
      Array.from({ length: 198 }, (_, i) => `NEEDLE x${i}`).join("\n"),
    );
    // The cap is branch-agnostic, so exercise it on the branch that exists on
    // every runner: the fallback greps the ignored twin too, so
    // 198 in exact.txt + tracked.ts + dist/ignored.ts = exactly 200.
    const out = grep.run({ pattern: "NEEDLE" }, withoutRg(dir));
    expect(out.split("\n").filter((l) => l.includes("NEEDLE")).length).toBe(
      200,
    );
    expect(out).not.toContain("capped at");
  });
});
