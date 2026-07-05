import { z } from "zod";
import { SchemaVersion } from "./scalars.ts";

// UX-1: machine output for `kelson init`.
export const InitResult = z.object({
  store_path: z.string().min(1),
  lockfile: z.enum(["created", "existing"]),
  hooked: z.array(z.string().min(1)),
  schema_version: SchemaVersion,
});
export type InitResult = z.infer<typeof InitResult>;

// UX-1: machine output for `kelson pack lint` (PACK-3).
export const PackLintResult = z.object({
  ok: z.boolean(),
  required_bump: z.enum(["major", "minor", "patch", "none"]),
  prev_version: z.string().min(1),
  next_version: z.string().min(1),
  schema_version: SchemaVersion,
});
export type PackLintResult = z.infer<typeof PackLintResult>;
