import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openDb, sessionView } from "@obligato/kernel";
import { UiSessionView } from "@obligato/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";
import { seedTimelineSession } from "../timeline-helpers.ts";

const t = makeTestRepo({});
const dbPath = join(t.repo, ".obligato", "show.db");
const db = openDb(dbPath);
const fx = seedTimelineSession(db);
db.close();

describe("UX-52: obligato session show renders the UX-50 view — header, one row per item, --json identity", () => {
  it("text: header with n/a for the null cost, one table row per item (count via the independent --json route)", async () => {
    const text = await runCli(t, [
      "session",
      "show",
      fx.sessionId,
      "--db",
      dbPath,
    ]);
    expect(text.exitCode).toBe(0);
    // revert-check: render the null cost as $0.0000 → this line fails.
    expect(text.stdout).toContain("n/a (1 unpriced)");
    expect(text.stdout).toContain(`session  ${fx.sessionId}`);
    expect(text.stdout).toContain("runner   native");
    const json = await runCli(t, [
      "session",
      "show",
      fx.sessionId,
      "--db",
      dbPath,
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    const parsed = UiSessionView.parse(JSON.parse(json.stdout));
    const lines = text.stdout.trimEnd().split("\n");
    const sep = lines.findIndex((l) => l.startsWith("─"));
    expect(sep).toBeGreaterThan(0);
    // revert-check: drop a row from the table map → row count ≠ items.length.
    expect(lines.length - sep - 1).toBe(parsed.items.length);
    expect(parsed.items.length).toBe(9);
    // tool outcomes carry symbols (UX-4)
    expect(text.stdout).toContain("✓ read line1");
  });

  it("--json is the kernel view by identity", async () => {
    const json = await runCli(t, [
      "session",
      "show",
      fx.sessionId,
      "--db",
      dbPath,
      "--json",
    ]);
    const fresh = openDb(dbPath);
    const expected = JSON.parse(
      JSON.stringify(sessionView(fresh, fx.sessionId)),
    );
    fresh.close();
    expect(JSON.parse(json.stdout)).toEqual(expected);
  });

  it("unknown session: non-zero exit naming obligato chat; --json still parses as the empty shape", async () => {
    const text = await runCli(t, [
      "session",
      "show",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--db",
      dbPath,
    ]);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("obligato chat");
    const json = await runCli(t, [
      "session",
      "show",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--db",
      dbPath,
      "--json",
    ]);
    expect(json.exitCode).toBe(1);
    expect(UiSessionView.parse(JSON.parse(json.stdout))).toEqual({
      empty_verb: "obligato chat",
      session: null,
      items: [],
    });
  });
});
