import { describe, expect, it } from "bun:test";
import { registerArtifact, staleDownstream } from "../../src/artifacts.ts";
import { ingestManifest } from "../../src/obspec.ts";
import { openDb } from "../../src/storage.ts";
import {
  compileRateLimiter,
  loadRateLimiter,
  RATE_LIMITER_FILE,
  rateLimiterMarkdown,
} from "../obspec-helpers.ts";

describe("DSL-6: the manifest maps each clause ID to block hash, obligation target, and tier; editing one block changes exactly that clause", () => {
  it("manifest carries one entry per clause/invariant with target and tier", () => {
    const { manifest } = loadRateLimiter();
    expect(manifest.component).toBe("rate-limiter");
    expect(manifest.entries.map((e) => e.clause_id).sort()).toEqual([
      "RL-1",
      "RL-INV-1",
    ]);
    const rl1 = manifest.entries.find((e) => e.clause_id === "RL-1");
    expect(rl1?.obligation_target).toBe("test/obligations/RL-1.test.ts");
    expect(rl1?.tier).toBe("T1");
    const inv = manifest.entries.find((e) => e.clause_id === "RL-INV-1");
    expect(inv?.obligation_target).toBe("tla/RateLimiter.tla");
  });

  it("round-trip: editing one block changes exactly that clause's hash and flags exactly its downstream trace links", () => {
    const db = openDb(":memory:");
    const before = loadRateLimiter().manifest;
    ingestManifest(db, "r", before);

    registerArtifact(db, {
      repo: "r",
      logical_id: "src/limiter.ts",
      type: "code_region",
      content: "limiter-v1",
      upstream: [`${RATE_LIMITER_FILE}#RL-1`],
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "src/invariant-probe.ts",
      type: "code_region",
      content: "probe-v1",
      upstream: [`${RATE_LIMITER_FILE}#RL-INV-1`],
    });
    expect(staleDownstream(db, "r")).toEqual([]);

    const edited = rateLimiterMarkdown().replace(
      "the rate limiter shall reject the request",
      "the rate limiter shall refuse the request",
    );
    const res = compileRateLimiter(edited);
    if (!res.ok || res.spec === null)
      throw new Error("edited fixture must compile");
    const after = res.spec.manifest;

    const hash = (m: typeof before, id: string) =>
      m.entries.find((e) => e.clause_id === id)?.block_hash;
    expect(hash(after, "RL-1")).not.toBe(hash(before, "RL-1"));
    expect(hash(after, "RL-INV-1")).toBe(hash(before, "RL-INV-1"));
    expect(after.spec_hash).not.toBe(before.spec_hash);

    ingestManifest(db, "r", after);
    expect(staleDownstream(db, "r")).toEqual(["src/limiter.ts"]);
    db.close();
  });
});
