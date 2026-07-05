import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const IsoUtc = z.iso.datetime();
export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const MicroUsd = z.number().int().nonnegative();
export const SchemaVersion = z.number().int().positive();
export const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
// Comparator sets (">=0.1 <2") joined by "||"; syntax validation only — satisfaction is checked at load.
const rangeComparator = String.raw`(?:>=|<=|>|<|~|\^|=)?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?|\*|x`;
export const SemverRange = z
  .string()
  .regex(
    new RegExp(
      `^\\s*(?:${rangeComparator})(?:\\s+(?:${rangeComparator}))*(?:\\s*\\|\\|\\s*(?:${rangeComparator})(?:\\s+(?:${rangeComparator}))*)*\\s*$`,
    ),
  );
export const KebabName = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);

export type Ulid = z.infer<typeof Ulid>;
export type IsoUtc = z.infer<typeof IsoUtc>;
export type Sha256 = z.infer<typeof Sha256>;
export type MicroUsd = z.infer<typeof MicroUsd>;
export type SchemaVersion = z.infer<typeof SchemaVersion>;
export type Semver = z.infer<typeof Semver>;
export type SemverRange = z.infer<typeof SemverRange>;
export type KebabName = z.infer<typeof KebabName>;
