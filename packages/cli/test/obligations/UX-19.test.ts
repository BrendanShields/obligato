import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { DoctorReport } from "@kelson/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

describe("UX-19: doctor names each failing component and its fix; healthy exits 0; never echoes credentials", () => {
  it("with no auth file, the auth component fails naming `kelson auth login <provider>`, exit non-zero, --json validates", async () => {
    const t = makeTestRepo({});
    mkdirSync(join(t.repo, ".kelson", "telemetry"), { recursive: true });
    const r = await runCli(t, [
      "doctor",
      "--db",
      join(t.repo, ".kelson", "kelson.db"),
      "--json",
    ]);
    expect(r.exitCode).not.toBe(0);
    const report = DoctorReport.parse(JSON.parse(r.stdout));
    expect(report.ok).toBe(false);
    const auth = report.components.find((c) => c.name === "auth");
    expect(auth?.status).toBe("fail");
    expect(auth?.fix).toBe("kelson auth login <provider>");
  }, 30_000);

  it("a missing store fails naming `kelson init` and the probe never creates it (audit pin)", async () => {
    const t = makeTestRepo({});
    mkdirSync(join(t.repo, ".kelson", "telemetry"), { recursive: true });
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    const r = await runCli(t, ["doctor", "--db", dbPath, "--json"]);
    expect(r.exitCode).not.toBe(0);
    const report = DoctorReport.parse(JSON.parse(r.stdout));
    const store = report.components.find((c) => c.name === "store");
    expect(store?.status).toBe("fail");
    expect(store?.fix).toBe("kelson init");
    expect(existsSync(dbPath)).toBe(false); // the diagnostic mutated nothing
  }, 30_000);

  it("healthy fixture exits 0 with every component passing; output carries no credential substring", async () => {
    const t = makeTestRepo({});
    mkdirSync(join(t.repo, ".kelson", "telemetry"), { recursive: true });
    const secret = "sk-fixture-secret-123";
    writeFileSync(
      join(t.home, ".kelson", "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: secret } }),
    );
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    openDb(dbPath).close(); // healthy = the store exists (UX-19 audit pin)
    const rendered = await runCli(t, ["doctor", "--db", dbPath]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain("auth");
    expect(rendered.stdout + rendered.stderr).not.toContain(secret);
    const j = await runCli(t, ["doctor", "--db", dbPath, "--json"]);
    expect(j.exitCode).toBe(0);
    const report = DoctorReport.parse(JSON.parse(j.stdout));
    expect(report.ok).toBe(true);
    expect(report.components.every((c) => c.status === "pass")).toBe(true);
    expect(j.stdout).not.toContain(secret);
  }, 30_000);
});
