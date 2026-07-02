import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PATHS, createUiServer } from "../../src/ui/server.ts";

// Empty-store fixture: a db path whose file does not exist yet — openDb
// creates and migrates an empty store on first touch.
const dir = mkdtempSync(join(tmpdir(), "kelson-ux12-"));
const server = createUiServer({
  dbPath: join(dir, "fresh.db"),
  changelogPath: join(dir, "missing-changelog.jsonl"),
  port: 0,
});
afterAll(() => server.stop(true));

describe("UX-12: a missing/empty store returns a schema-valid empty result naming the producing CLI verb, never an error", () => {
  it("every route returns 200 with an empty_verb naming a kelson command", async () => {
    for (const path of API_PATHS) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      const body = (await res.json()) as { empty_verb: string };
      expect(body.empty_verb).toStartWith("kelson ");
    }
  });
});
