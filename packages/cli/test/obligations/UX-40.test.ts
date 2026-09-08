import { describe, expect, it } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HookDefinition, HooksListResult } from "@obligato/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const HOOKS: HookDefinition[] = [
  {
    event: "pre_tool",
    matcher: "bash",
    command: "sh guard.sh",
    timeout_ms: 500,
  },
  { event: "session_end", command: "sh notify.sh" },
];

describe("UX-40: obligato hooks list renders the repo's hooks through the runtime loader; missing file is one line; invalid file fails naming the path", () => {
  it("a two-hook file renders both rows with units and --json matches the file verbatim", async () => {
    const t = makeTestRepo({});
    writeFileSync(
      join(t.repo, ".obligato", "hooks.json"),
      JSON.stringify({ schema_version: 1, hooks: HOOKS }),
    );
    const r = await runCli(t, ["hooks", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("pre_tool");
    expect(r.stdout).toContain("sh guard.sh");
    expect(r.stdout).toContain("session_end");
    expect(r.stdout).toContain("sh notify.sh");
    expect(r.stdout).toContain("500 ms");
    // The AGT-20 default is rendered, not blank.
    expect(r.stdout).toContain("10000 ms");
    const j = await runCli(t, ["hooks", "list", "--json"]);
    expect(j.exitCode).toBe(0);
    const parsed = HooksListResult.parse(JSON.parse(j.stdout));
    // revert-check: fill defaults into the JSON → the deep-equal below fails on timeout_ms.
    expect(parsed.hooks).toEqual(HOOKS);
    // The child's cwd is realpath-resolved (macOS /var → /private/var).
    expect(parsed.path).toBe(
      join(realpathSync(t.repo), ".obligato", "hooks.json"),
    );
  });

  it("a repo without hooks.json renders exactly one line and --json yields an empty list", async () => {
    const t = makeTestRepo({});
    const r = await runCli(t, ["hooks", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("no hooks configured (.obligato/hooks.json)");
    const j = await runCli(t, ["hooks", "list", "--json"]);
    expect(HooksListResult.parse(JSON.parse(j.stdout)).hooks).toEqual([]);
  });

  it("an invalid file exits non-zero naming the path", async () => {
    const t = makeTestRepo({});
    const path = join(t.repo, ".obligato", "hooks.json");
    writeFileSync(
      path,
      JSON.stringify({ schema_version: 1, hooks: [{ event: "nope" }] }),
    );
    const r = await runCli(t, ["hooks", "list"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(path);
  });

  it("identity: the command module imports the runtime's loadHooks (F-085)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "commands", "hooks.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /import \{[^}]*loadHooks[^}]*\} from "@obligato\/agent"/,
    );
    expect(src).not.toContain("HooksFile.parse");
  });
});
