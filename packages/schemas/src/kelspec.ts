import { z } from "zod";
import { Authority, Tier } from "./artifacts.ts";
import { KebabName, Sha256 } from "./scalars.ts";

export const EventName = z.string().regex(/^[a-z][a-z0-9_]*$/);
export const ClauseId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const InvariantId = z.string().regex(/^[A-Z][A-Z0-9]*-INV-\d+$/);
const Identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const DottedPath = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);
const DomainRef = z.string().min(1);

export const KelspecStateVar = z.strictObject({
  name: Identifier,
  mutated_by: z.array(EventName),
});

export const KelspecComponent = z.strictObject({
  kind: z.literal("component"),
  id: KebabName,
  tier: Tier,
  authority: Authority,
  state: z.array(KelspecStateVar).default([]),
  events: z.array(EventName).default([]),
  domains_of_concern: z.array(z.string().min(1)).default([]),
});

// DSL-2: numeric domains without unit or bounds are rejected at the grammar,
// not by the generator — every constraint field here is generator-facing.
const numericDomain = {
  id: DomainRef,
  unit: z.string().min(1),
};
export const KelspecDomain = z.discriminatedUnion("type", [
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("int"),
    ...numericDomain,
    min: z.number().int(),
    max: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("float"),
    ...numericDomain,
    min: z.number(),
    max: z.number(),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("string"),
    id: DomainRef,
    pattern: z.string().min(1).nullable().default(null),
    max_length: z.number().int().positive().nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("enum"),
    id: DomainRef,
    values: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("struct"),
    id: DomainRef,
    fields: z.record(Identifier, DomainRef),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("list"),
    id: DomainRef,
    of: DomainRef,
    max_items: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("domain"),
    type: z.literal("map"),
    id: DomainRef,
    keys: DomainRef,
    values: DomainRef,
    max_items: z.number().int().nonnegative().default(32),
  }),
]);

export const EarsForm = z.enum([
  "ubiquitous",
  "event",
  "state",
  "unwanted",
  "optional",
]);

export const Unverifiable = z.strictObject({
  signed_by: z.string().min(1),
  reason: z.string().min(1),
});

export const KelspecClause = z
  .strictObject({
    kind: z.literal("clause"),
    id: ClauseId,
    ears: EarsForm,
    trigger: EventName.nullable().default(null),
    text: z.string().min(1),
    inputs: z.record(Identifier, DomainRef).default({}),
    observe: z.array(DottedPath).default([]),
    check: z.string().min(1).nullable().default(null),
    pre: z.string().min(1).nullable().default(null),
    post: z.string().min(1).nullable().default(null),
    nondeterministic: z.array(DottedPath).default([]),
    unverifiable: Unverifiable.nullable().default(null),
  })
  .check((ctx) => {
    const needsTrigger =
      ctx.value.ears === "event" || ctx.value.ears === "unwanted";
    if (needsTrigger && ctx.value.trigger === null)
      ctx.issues.push({
        code: "custom",
        message: `ears form "${ctx.value.ears}" requires a trigger`,
        path: ["trigger"],
        input: ctx.value,
      });
  });

export const KelspecInvariant = z.strictObject({
  kind: z.literal("invariant"),
  id: InvariantId,
  text: z.string().min(1),
  over: z.array(Identifier).min(1),
  check: z.string().min(1),
  model: z.string().min(1).nullable().default(null),
});

export const KelspecBlock = z.discriminatedUnion("kind", [
  KelspecComponent,
  KelspecDomain,
  KelspecClause,
  KelspecInvariant,
]);

// DSL-6: one entry per clause/invariant block; block hashes are independent of
// the whole-file hash so clause-level staleness works without file churn.
export const ManifestEntry = z.strictObject({
  clause_id: z.string().min(1),
  kind: z.enum(["clause", "invariant"]),
  block_hash: Sha256,
  obligation_target: z.string().min(1),
  tier: Tier,
});

export const KelspecManifest = z.strictObject({
  spec_path: z.string().min(1),
  component: KebabName,
  spec_hash: Sha256,
  entries: z.array(ManifestEntry),
  unverifiable_ratio: z.number().min(0).max(1),
});

export type KelspecStateVar = z.infer<typeof KelspecStateVar>;
export type KelspecComponent = z.infer<typeof KelspecComponent>;
export type KelspecDomain = z.infer<typeof KelspecDomain>;
export type EarsForm = z.infer<typeof EarsForm>;
export type Unverifiable = z.infer<typeof Unverifiable>;
export type KelspecClause = z.infer<typeof KelspecClause>;
export type KelspecInvariant = z.infer<typeof KelspecInvariant>;
export type KelspecBlock = z.infer<typeof KelspecBlock>;
export type ManifestEntry = z.infer<typeof ManifestEntry>;
export type KelspecManifest = z.infer<typeof KelspecManifest>;
export type EventName = z.infer<typeof EventName>;
export type ClauseId = z.infer<typeof ClauseId>;
export type InvariantId = z.infer<typeof InvariantId>;
