import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { type Capability, Lockfile, PackManifest } from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";

const STAGES = new Set([
  "feedback",
  "ideation",
  "planning",
  "spec",
  "build",
  "verify",
]);

const DIR_CAPABILITY: Record<string, Capability> = {
  rules: "rules",
  routing: "routing-table",
  agents: "agent-registry",
  context: "context-assembly",
  suites: "eval-suite",
};

// PACK-1: deterministic path → capability. Fail-closed — an unmappable path is
// an unknown surface under SEC-4, refused rather than ignored.
export const requiredCapability = (path: string): Capability | null => {
  if (path === "pack.yaml" || path === "pack.sig") return null;
  const [head, ...rest] = path.split("/");
  if (head === "skills") {
    if (rest.length < 2)
      throw new Error(
        `pack layout error: ${path} — skill files live under skills/<stage>/, not skills/`,
      );
    const stage = rest[0] as string;
    if (!STAGES.has(stage))
      throw new Error(
        `pack layout error: ${path} — unknown stage directory skills/${stage}/`,
      );
    return `stage:${stage}` as Capability;
  }
  const cap = head && DIR_CAPABILITY[head];
  if (!cap)
    throw new Error(
      `pack layout error: ${path} — no capability mapping for this path (PACK-1 fail-closed)`,
    );
  return cap;
};

// Pack paths are POSIX-style wherever mapped or hashed (pack-format §1) —
// hashes must be identical across platforms, so never emit the platform sep.
const listFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      [e.parentPath.slice(dir.length + 1), e.name]
        .filter(Boolean)
        .join(sep)
        .replaceAll(sep, "/"),
    )
    .sort();

// PACK-2 content hash: path-sorted, each file contributes path + "\0" + bytes;
// manifest included, pack.sig excluded (the signature cannot cover itself).
export const hashPackContent = (dir: string): string => {
  const h = createHash("sha256");
  for (const path of listFiles(dir)) {
    if (path === "pack.sig") continue;
    h.update(path);
    h.update("\0");
    h.update(readFileSync(join(dir, path)));
  }
  return `sha256:${h.digest("hex")}`;
};

export interface LoadedPack {
  manifest: PackManifest;
  content_hash: string;
  files: string[];
}

// PACK-1 + SEC-4: manifest validated (kernel_compat as a semver range — the
// schema enforces it), every content path mapped, undeclared capability refused
// naming the file and the missing capability.
export const loadPack = (dir: string): LoadedPack => {
  const manifest = PackManifest.parse(
    Bun.YAML.parse(readFileSync(join(dir, "pack.yaml"), "utf8")),
  );
  const declared = new Set(manifest.capabilities);
  const files = listFiles(dir);
  for (const path of files) {
    const cap = requiredCapability(path);
    if (cap && !declared.has(cap))
      throw new Error(
        `capability refusal (SEC-4): ${path} requires undeclared capability "${cap}"`,
      );
  }
  return { manifest, content_hash: hashPackContent(dir), files };
};

// PACK-2 (partial): tamper refusal by hash mismatch. Ed25519 signature
// verification lands with the registry keys (Phase 5).
export const verifyPackContent = (dir: string, expected: string): void => {
  const actual = hashPackContent(dir);
  if (actual !== expected)
    throw new Error(
      `pack content hash mismatch (PACK-2): expected ${expected}, got ${actual} — refusing install`,
    );
};

// RFC 8785 canonical form for our value domain (sorted keys, no whitespace;
// JSON.stringify's string/number/bool/null serialization matches JCS here).
export const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
};

// PACK-4: the hash identifies configuration content; parent_hash chains
// history and is excluded so identical configurations hash identically.
export const hashLockfile = (raw: unknown): string => {
  const { parent_hash: _excluded, ...content } = Lockfile.parse(raw);
  return hashContent(canonicalJson(content));
};
