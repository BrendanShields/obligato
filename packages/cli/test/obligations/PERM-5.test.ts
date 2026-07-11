import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@obligato/kernel";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

const done = { kind: "text" as const, text: "all done" };
const bash = (id: string, command: string) => ({
  kind: "tool" as const,
  id,
  name: "bash",
  input: { command },
});
const write = (id: string, path: string) => ({
  kind: "tool" as const,
  id,
  name: "write",
  input: { path, content: "x" },
});

describe("PERM-5: granular headless allows resolve asks; defaults and denies never yield", () => {
  it("(a) --allow bash executes the bash ask; the write ask in the same session still denies", async () => {
    const server = mockOpenAiServer([
      bash("c1", "echo made > bashed.txt"),
      write("c2", "made.txt"),
      done,
    ]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "go", "--allow", "bash"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "bashed.txt"))).toBe(true);
    expect(existsSync(join(t.repo, "made.txt"))).toBe(false);
    // The denial was error-result feedback, not a crash: the write's stored
    // tool_result carries is_error while the bash one does not.
    const db = openDb(join(t.home, ".obligato", "obligato.db"));
    const results = (
      db
        .query(
          "SELECT payload FROM session_event WHERE kind = 'tool_result' ORDER BY rowid",
        )
        .all() as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as { is_error?: boolean });
    expect(results.map((p) => p.is_error === true)).toEqual([false, true]);
    server.stop();
  }, 20_000);

  it("(b) --allow write:glob writes the matching path and denies the non-matching one", async () => {
    const server = mockOpenAiServer([
      write("c1", "good-a.txt"),
      write("c2", "bad-b.txt"),
      done,
    ]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "go", "--allow", "write:good-*"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "good-a.txt"))).toBe(true);
    expect(existsSync(join(t.repo, "bad-b.txt"))).toBe(false);
    server.stop();
  }, 20_000);

  it("(c) no --allow flags: every ask denies (PERM-3 unchanged)", async () => {
    const server = mockOpenAiServer([write("c1", "made.txt"), done]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "go"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "made.txt"))).toBe(false);
    server.stop();
  }, 20_000);

  it("(d) a repo deny rule still denies the --allow'd tool (deny trumps)", async () => {
    const server = mockOpenAiServer([
      bash("c1", "echo made > bashed.txt"),
      done,
    ]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    writeFileSync(
      join(t.repo, ".obligato", "permissions.json"),
      JSON.stringify([{ tool: "bash", action: "deny" }]),
    );
    const r = await runCli(t, ["run", "-p", "go", "--allow", "bash"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "bashed.txt"))).toBe(false);
    server.stop();
  }, 20_000);

  it("(e) defaults never grant: a repo read-ask rule plus a non-matching allow list still denies", async () => {
    const server = mockOpenAiServer([
      {
        kind: "tool" as const,
        id: "c1",
        name: "read",
        input: { path: "secret.txt" },
      },
      done,
    ]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    writeFileSync(join(t.repo, "secret.txt"), "TOPSECRET");
    writeFileSync(
      join(t.repo, ".obligato", "permissions.json"),
      JSON.stringify([{ tool: "read", action: "ask" }]),
    );
    const r = await runCli(t, ["run", "-p", "go", "--allow", "bash"]);
    expect(r.exitCode).toBe(0);
    // The read was denied: its tool_result is an error and the content
    // never entered the transcript.
    const db = openDb(join(t.home, ".obligato", "obligato.db"));
    const rows = db
      .query(
        "SELECT payload FROM session_event WHERE kind = 'tool_result' ORDER BY rowid",
      )
      .all() as { payload: string }[];
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as {
      is_error?: boolean;
      output?: string;
    };
    expect(payload.is_error).toBe(true);
    expect(payload.output ?? "").not.toContain("TOPSECRET");
    server.stop();
  }, 20_000);

  it("(f) --allow-asks without a granular list behaves as before", async () => {
    const server = mockOpenAiServer([write("c1", "made.txt"), done]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "go", "--allow-asks"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "made.txt"))).toBe(true);
    server.stop();
  }, 20_000);
});
