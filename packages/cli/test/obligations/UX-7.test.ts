import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "index.ts");

describe("UX-7: bare kelson on a TTY opens the launcher; non-TTY prints plain help and exits 0 without prompting", () => {
  it("piped stdio: help on stdout, exit 0, no prompt escapes, terminates with no input", async () => {
    const proc = Bun.spawn(["bun", CLI], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // terminates with no input — a hung prompt fails here, not the assertion
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
    ]);
    if (exited === "timeout") {
      proc.kill();
      throw new Error("kelson with piped stdio did not terminate (prompted?)");
    }
    const out = await new Response(proc.stdout).text();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("kelson");
    expect(out).toContain("init");
    expect(out).toContain("eval");
    // no interactive prompting: no cursor-control or alt-screen sequences
    expect(out).not.toMatch(/\x1b\[\?1049|\x1b\[\?25l|\x1b\[2J/);
  }, 15_000);
});
