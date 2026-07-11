import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitResult, PackLintResult } from "@obligato/schemas";
import { COMMANDS } from "../../src/index.ts";
import { JSON_OUTPUT } from "../../src/output/registry.ts";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

// A byte-identical pack pair → requiredBump "none" → lint ok.
const makePack = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "obligato-pack-"));
  writeFileSync(
    join(dir, "pack.yaml"),
    JSON.stringify({
      schema_version: 1,
      name: "fixture-pack",
      version: "1.0.0",
      kind: "efficiency",
      kernel_compat: "*",
      capabilities: ["rules"],
      description: "fixture",
    }),
  );
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", "a.md"), "x");
  return dir;
};

describe("UX-1: every CLI command declares a --json contract or a recorded skip; offline schema-backed commands validate", () => {
  it("the JSON-output registry covers exactly the COMMANDS dispatch table (fail-closed on a new command)", () => {
    expect(Object.keys(JSON_OUTPUT).sort()).toEqual(
      Object.keys(COMMANDS).sort(),
    );
  });

  it("obligato init --json emits an InitResult", async () => {
    const t = makeTestRepo({});
    const r = await runCli(t, ["init", "--dir", t.repo, "--json"]);
    expect(r.exitCode).toBe(0);
    expect(InitResult.safeParse(JSON.parse(r.stdout)).success).toBe(true);
  });

  it("obligato pack lint --json emits a PackLintResult", async () => {
    const t = makeTestRepo({});
    const r = await runCli(t, [
      "pack",
      "lint",
      makePack(),
      "--prev",
      makePack(),
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = PackLintResult.safeParse(JSON.parse(r.stdout));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ok).toBe(true);
  });
});
