import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const IsoUtc = z.iso.datetime();
export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const MicroUsd = z.number().int().nonnegative();
export const SchemaVersion = z.number().int().positive();
export const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
export const KebabName = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);

export type Ulid = z.infer<typeof Ulid>;
export type IsoUtc = z.infer<typeof IsoUtc>;
export type Sha256 = z.infer<typeof Sha256>;
