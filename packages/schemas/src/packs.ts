import { z } from "zod";
import { KebabName, SchemaVersion, Semver, Sha256 } from "./scalars.ts";

export const PackKind = z.enum([
  "stage",
  "efficiency",
  "spec_tooling",
  "routing",
  "eval_suite",
  "agent_registry",
]);

// Closed enum per pack-format spec §1 — extending it is a spec change first (SEC-4 surface).
export const Capability = z.enum([
  "stage:feedback",
  "stage:ideation",
  "stage:planning",
  "stage:spec",
  "stage:build",
  "stage:verify",
  "rules",
  "routing-table",
  "agent-registry",
  "eval-suite",
  "context-assembly",
]);

export const PackManifest = z.object({
  schema_version: SchemaVersion,
  name: KebabName,
  version: Semver,
  kind: PackKind,
  kernel_compat: z.string().min(1),
  capabilities: z
    .array(Capability)
    .min(1)
    .refine((c) => new Set(c).size === c.length, "capabilities must be unique"),
  description: z.string().min(1).max(200),
});

export const LockfileEntry = z.object({
  name: KebabName,
  version: Semver,
  hash: Sha256,
  enabled: z.boolean(),
});

export const Lockfile = z.object({
  schema_version: SchemaVersion,
  parent_hash: Sha256.nullable(),
  entries: z.array(LockfileEntry),
});

export type PackManifest = z.infer<typeof PackManifest>;
export type Lockfile = z.infer<typeof Lockfile>;
export type LockfileEntry = z.infer<typeof LockfileEntry>;
