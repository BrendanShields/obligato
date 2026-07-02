import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashPackContent, verifyPackContent } from "../../src/packs.ts";

const FILES: Record<string, string> = {
  "pack.yaml": "schema_version: 1\nname: fixture\n",
  "rules/a.md": "rule content",
  "skills/build/b.md": "skill content",
};

const writePack = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "kelson-tamper-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe("PACK-2 (partial): one flipped byte in any file fails install", () => {
  it("verify passes on untampered content and refuses after any single-byte flip", () => {
    const dir = writePack(FILES);
    const expected = hashPackContent(dir);
    verifyPackContent(dir, expected);

    for (const path of Object.keys(FILES)) {
      const target = join(dir, path);
      const original = readFileSync(target);
      const tampered = Buffer.from(original);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      writeFileSync(target, tampered);
      expect(() => verifyPackContent(dir, expected)).toThrow(/mismatch/);
      writeFileSync(target, original);
      verifyPackContent(dir, expected);
    }
  });

  it("pack.sig is excluded from the content hash — the signature cannot cover itself", () => {
    const dir = writePack(FILES);
    const before = hashPackContent(dir);
    writeFileSync(join(dir, "pack.sig"), "detached-signature");
    expect(hashPackContent(dir)).toBe(before);
  });

  it("renaming a path changes the hash even with identical bytes (path + \\0 + bytes)", () => {
    const a = writePack({ "rules/a.md": "same" });
    const b = writePack({ "rules/b.md": "same" });
    expect(hashPackContent(a)).not.toBe(hashPackContent(b));
  });

  it.todo("Ed25519 signature verified against the registry-published key; --unsigned flags telemetry (registry keys, Phase 5)", () => {});
});
