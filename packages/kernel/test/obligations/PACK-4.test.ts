import { describe, expect, it } from "bun:test";
import type { Lockfile } from "@kelson/schemas";
import fc from "fast-check";
import { canonicalJson, hashLockfile } from "../../src/packs.ts";

const sha256 = fc
  .array(fc.constantFrom(..."0123456789abcdef"), {
    minLength: 64,
    maxLength: 64,
  })
  .map((cs) => `sha256:${cs.join("")}`);
const kebab = fc.constantFrom("ponytail", "tdd-pack", "router-v2", "a");
const semver = fc
  .tuple(fc.nat(20), fc.nat(20), fc.nat(20))
  .map(([a, b, c]) => `${a}.${b}.${c}`);

const lockfileArb: fc.Arbitrary<Lockfile> = fc.record({
  schema_version: fc.integer({ min: 1, max: 99 }),
  parent_hash: fc.option(sha256, { nil: null }),
  entries: fc.array(
    fc.record({
      name: kebab,
      version: semver,
      hash: sha256,
      enabled: fc.boolean(),
    }),
    { maxLength: 5 },
  ),
});

// Rebuild the value inserting object keys in reverse order — semantically
// identical, different property order and (via stringify) different formatting.
const reversedKeys = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(reversedKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).reverse())
    out[k] = reversedKeys((v as Record<string, unknown>)[k]);
  return out;
};

describe("PACK-4: lockfile hashing is canonical", () => {
  it("hash is invariant under key-order and whitespace formatting permutations", () => {
    fc.assert(
      fc.property(lockfileArb, (lock) => {
        const base = hashLockfile(lock);
        expect(hashLockfile(reversedKeys(lock))).toBe(base);
        expect(hashLockfile(JSON.parse(JSON.stringify(lock, null, 4)))).toBe(
          base,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("parent_hash is excluded: it chains history, not configuration content", () => {
    fc.assert(
      fc.property(lockfileArb, sha256, (lock, other) => {
        expect(hashLockfile({ ...lock, parent_hash: other })).toBe(
          hashLockfile({ ...lock, parent_hash: null }),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("every field mutation changes the hash", () => {
    fc.assert(
      fc.property(
        lockfileArb.filter((l) => l.entries.length > 0),
        fc.nat(),
        (lock, seed) => {
          const base = hashLockfile(lock);
          const i = seed % lock.entries.length;
          const entry = lock.entries[i] as Lockfile["entries"][number];
          const mutations: Lockfile[] = [
            { ...lock, schema_version: lock.schema_version + 1 },
            { ...lock, entries: lock.entries.toSpliced(i, 1) },
            mutateEntry(lock, i, { name: `${entry.name}-x` }),
            mutateEntry(lock, i, {
              version: `${entry.version.split(".")[0]}.99.99`,
            }),
            mutateEntry(lock, i, {
              hash:
                entry.hash === `sha256:${"0".repeat(64)}`
                  ? `sha256:${"1".repeat(64)}`
                  : `sha256:${"0".repeat(64)}`,
            }),
            mutateEntry(lock, i, { enabled: !entry.enabled }),
          ];
          for (const m of mutations) expect(hashLockfile(m)).not.toBe(base);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("canonical form sorts keys and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "s"] })).toBe(
      '{"a":[true,null,"s"],"b":1}',
    );
  });
});

const mutateEntry = (
  lock: Lockfile,
  i: number,
  patch: Partial<Lockfile["entries"][number]>,
): Lockfile => ({
  ...lock,
  entries: lock.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)),
});
