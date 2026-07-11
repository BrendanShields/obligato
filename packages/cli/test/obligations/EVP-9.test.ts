import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseTask,
  lockWith,
  makeSnapshot,
  makeSuite,
  tmpDir,
} from "../../../kernel/test/eval-helpers.ts";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

const setupEvalRepo = (baseUrl: string) => {
  const t = makeTestRepo({ baseUrl, configured: false });
  const store = tmpDir();
  // The task snapshot commits its own .obligato/config.json — the api
  // executor's model source inside the sandbox (EVP-9).
  const snapshot = makeSnapshot(
    {
      "README.md": "fixture\n",
      ".obligato/config.json": JSON.stringify({
        default_model: "mock-m",
        schema_version: 1,
      }),
    },
    store,
  );
  const suiteDir = makeSuite([
    baseTask({
      id: "t1",
      snapshot,
      statement: "create done.txt containing ok",
      checks: [{ kind: "artifact_exists", path: "done.txt" }],
      session_command: null,
    }),
  ]);
  const lockPath = join(t.repo, "fixture.lock");
  writeFileSync(
    lockPath,
    JSON.stringify(lockWith([{ name: "p", enabled: true }])),
  );
  const dbPath = join(t.repo, ".obligato", "obligato.db");
  return { t, suiteDir, lockPath, dbPath, store };
};

// One write + one final answer per session; two sessions (2 sides x 1 repeat).
const TURNS = [
  {
    kind: "tool" as const,
    id: "c1",
    name: "write",
    input: { path: "done.txt", content: "ok" },
  },
  { kind: "text" as const, text: "created" },
  {
    kind: "tool" as const,
    id: "c2",
    name: "write",
    input: { path: "done.txt", content: "ok" },
  },
  { kind: "text" as const, text: "created" },
];

describe("EVP-9: the api executor runs ablate end-to-end; container and unknown names refuse; ledger stays fenced", () => {
  it("obligato eval ablate --executor api completes to a verdict with executor recorded; publish refuses", async () => {
    const server = mockOpenAiServer(TURNS);
    const { t, suiteDir, lockPath, dbPath, store } = setupEvalRepo(server.url);
    const r = await runCli(t, [
      "eval",
      "ablate",
      "p",
      "--suite",
      suiteDir,
      "--executor",
      "api",
      "--lockfile",
      lockPath,
      "--repeats",
      "1",
      "--snapshots",
      store,
      "--db",
      dbPath,
    ]);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(r.stdout).toContain("verdict:");

    const db = new Database(dbPath, { readonly: true });
    const run = db
      .query("SELECT id, executor FROM eval_run ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string; executor: string };
    expect(run.executor).toBe("api");
    db.close();

    // EVP-7/EVP-9: ledger publication from an api run is refused.
    const publish = await runCli(t, [
      "eval",
      "publish",
      run.id,
      "p",
      "1.0.0",
      "--ledger",
      tmpDir(),
      "--db",
      dbPath,
    ]);
    expect(publish.exitCode).not.toBe(0);
    expect(publish.stderr + publish.stdout).toMatch(
      /executor "api"|not publishable/,
    );
    server.stop();
  }, 60_000);

  it("the container profile refuses with a diagnostic naming the profile", async () => {
    const server = mockOpenAiServer(TURNS);
    const { t, suiteDir, lockPath, dbPath } = setupEvalRepo(server.url);
    const r = await runCli(t, [
      "eval",
      "ablate",
      "p",
      "--suite",
      suiteDir,
      "--executor",
      "api",
      "--profile",
      "container",
      "--lockfile",
      lockPath,
      "--db",
      dbPath,
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("container");
    expect(server.calls()).toBe(0);
    server.stop();
  }, 30_000);

  it("EVP-8 on the native path: an override endpoint sees the dummy key, never the operator's real credential", async () => {
    // A capture server standing in for an arbitrary anthropic override
    // endpoint; assert the header VALUE (verification-independence, F-031).
    const seen: { apiKey: string | null; auth: string | null } = {
      apiKey: null,
      auth: null,
    };
    const capture = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen.apiKey = req.headers.get("x-api-key");
        seen.auth = req.headers.get("authorization");
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "capture" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });
    const store = tmpDir();
    const snapshot = makeSnapshot({ "README.md": "x\n" }, store);
    const suiteDir = makeSuite([
      baseTask({ id: "t1", snapshot, session_command: null }),
    ]);
    const t = makeTestRepo({ configured: false });
    const lockPath = join(t.repo, "fixture.lock");
    writeFileSync(
      lockPath,
      JSON.stringify(lockWith([{ name: "p", enabled: true }])),
    );
    // The operator's REAL key is in the env; an anthropic override entry
    // points at the capture endpoint. EVP-8 must withhold the real key.
    const env = {
      ...t.env,
      ANTHROPIC_API_KEY: "sk-OPERATOR-REAL-KEY",
    };
    writeFileSync(
      join(t.home, ".obligato", "models.json"),
      JSON.stringify([
        {
          id: "claude-opus-4-8",
          provider: "anthropic",
          context_window: 1_000_000,
          max_output: 64_000,
          prices: null,
          tools: true,
        },
      ]),
    );
    const r = await runCli({ ...t, env }, [
      "eval",
      "ablate",
      "p",
      "--suite",
      suiteDir,
      "--executor",
      "api",
      "--model",
      "claude-opus-4-8",
      "--base-url",
      `http://127.0.0.1:${capture.port}`,
      "--lockfile",
      lockPath,
      "--repeats",
      "1",
      "--snapshots",
      store,
      "--db",
      join(t.repo, ".obligato", "obligato.db"),
    ]);
    capture.stop(true);
    expect(r.exitCode).toBe(0); // sessions fail on 400 but the run completes
    expect(seen.apiKey).not.toBe("sk-OPERATOR-REAL-KEY");
    expect(seen.apiKey).toBe("obligato-local");
    expect(seen.auth).toBeNull();
  }, 60_000);

  it("an unknown executor name refuses at pre-flight", async () => {
    const server = mockOpenAiServer(TURNS);
    const { t, suiteDir, lockPath, dbPath } = setupEvalRepo(server.url);
    const r = await runCli(t, [
      "eval",
      "ablate",
      "p",
      "--suite",
      suiteDir,
      "--executor",
      "bogus",
      "--lockfile",
      lockPath,
      "--db",
      dbPath,
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown executor");
    expect(server.calls()).toBe(0);
    server.stop();
  }, 30_000);
});
