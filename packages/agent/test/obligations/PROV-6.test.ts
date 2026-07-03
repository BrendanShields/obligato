import { describe, expect, it } from "bun:test";
import { openDb } from "@kelson/kernel";
import { runTurn } from "../../src/loop.ts";
import {
  authKindOf,
  createAgentSession,
  listEvents,
} from "../../src/sessions.ts";
import { fixture, textResponse } from "../helpers.ts";

describe("PROV-6: sessions record their auth kind; subscription runs still cost at list prices", () => {
  it("authKindOf maps credentials to kinds", () => {
    expect(authKindOf(null)).toBe("none");
    expect(authKindOf({ type: "api_key" })).toBe("api_key");
    expect(authKindOf({ type: "token" })).toBe("subscription");
    expect(authKindOf({ type: "oauth" })).toBe("subscription");
  });

  it("session_meta carries the stated auth_kind for each kind", () => {
    const db = openDb(":memory:");
    for (const kind of ["subscription", "api_key", "none"] as const) {
      const { sessionId } = createAgentSession(db, {
        repo: "r",
        lockfile_hash: `sha256:${"0".repeat(64)}`,
        harness_version: "0.0.1",
        model: "m",
        system: "s",
        auth_kind: kind,
      });
      const meta = listEvents(db, sessionId).find(
        (e) => e.kind === "session_meta",
      );
      expect(meta?.payload.auth_kind).toBe(kind);
    }
  });

  it("a priced model under a subscription session yields non-null list-price step costs", async () => {
    const f = fixture([textResponse("done")]);
    f.deps.authKind = "subscription";
    await runTurn(f.deps);
    const row = f.db
      .query("SELECT cost_micro_usd FROM step_event WHERE session_id = ?")
      .get(f.sessionId) as { cost_micro_usd: number | null };
    // Hand-computed from USAGE_FIXTURE x TEST_ENTRY prices (see AGT-3): 548.
    expect(row.cost_micro_usd).toBe(548);
  });
});
