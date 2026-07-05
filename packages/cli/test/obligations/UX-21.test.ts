import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPack } from "@kelson/kernel";
import { PackNewResult } from "@kelson/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

describe("UX-21: pack new scaffolds a manifest with explicit capabilities covering its content; self-lint exits 0", () => {
  it("the scaffold loads without a SEC-4 refusal, declares its content's capabilities, and self-lints green", async () => {
    const t = makeTestRepo({});
    const r = await runCli(t, [
      "pack",
      "new",
      "mypack",
      "--dir",
      t.repo,
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const result = PackNewResult.parse(JSON.parse(r.stdout));
    const dir = result.dir;
    expect(existsSync(join(dir, "pack.yaml"))).toBe(true);
    // loadPack enforces the SEC-4 capability ceiling — a scaffold with
    // undeclared content dirs would throw here.
    const loaded = loadPack(dir);
    expect(loaded.manifest.capabilities).toContain("rules");
    expect(existsSync(join(dir, "rules"))).toBe(true);
    // Self-lint through the real pack lint entry: unchanged pack requires
    // bump "none" → ok.
    const lint = await runCli(t, ["pack", "lint", dir, "--prev", dir]);
    expect(lint.exitCode).toBe(0);
  }, 30_000);

  it("an invalid name scaffolds nothing", async () => {
    const t = makeTestRepo({});
    const r = await runCli(t, [
      "pack",
      "new",
      "Not_Kebab",
      "--dir",
      t.repo,
      "--json",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(t.repo, "Not_Kebab"))).toBe(false);
  }, 30_000);
});
