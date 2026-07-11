import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ObspecBlock,
  type ObspecClause,
  type ObspecComponent,
  type ObspecDomain,
  type ObspecInvariant,
  type ObspecManifest,
} from "@obligato/schemas";
import fc from "fast-check";
import { hashContent } from "./artifacts.ts";
import { domainArbitrary } from "./generators.ts";
import { analyzeCheck, buildContext, compilePredicate } from "./predicate.ts";

export interface CompileError {
  file: string;
  block_index: number | null;
  clause_id: string | null;
  path: string | null;
  message: string;
}

// The harness maps a generated input assignment to the observation surface;
// reserved keys `state`/`state_prime` feed a clause's `post` predicate.
export type ObservationHarness = (
  inputs: Record<string, unknown>,
) => Record<string, unknown>;

export interface CompiledClause {
  id: string;
  tier: ObspecComponent["tier"];
  block_hash: string;
  unverifiable: boolean;
  makeProperty:
    | ((harness: ObservationHarness) => fc.IPropertyWithHooks<[unknown]>)
    | null;
}

export interface CompiledInvariant {
  id: string;
  block_hash: string;
  model: string | null;
  probe: (state: Record<string, unknown>) => boolean;
}

export interface CompiledSpec {
  file: string;
  component: ObspecComponent;
  domains: Map<string, ObspecDomain>;
  clauses: CompiledClause[];
  invariants: CompiledInvariant[];
  manifest: ObspecManifest;
}

export type CompileResult =
  | { ok: true; spec: CompiledSpec | null }
  | { ok: false; errors: CompileError[] };

export interface RawBlock {
  source: string;
  index: number;
}

// DSL-1: fenced `obspec` blocks are the sole clause source; prose is never
// load-bearing, so a prose-only file is an empty spec, not an error.
export const extractBlocks = (markdown: string): RawBlock[] => {
  const fence = /^```obspec[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  return [...markdown.matchAll(fence)].map((m, i) => ({
    source: m[1] as string,
    index: i,
  }));
};

const eventSet = (component: ObspecComponent): Set<string> => {
  const events = new Set(component.events);
  for (const sv of component.state)
    for (const ev of sv.mutated_by) events.add(ev);
  return events;
};

export const compileSpec = (
  markdown: string,
  opts: { file: string; rootDir?: string },
): CompileResult => {
  const errors: CompileError[] = [];
  const err = (
    message: string,
    at: { block_index?: number; clause_id?: string; path?: string } = {},
  ) =>
    errors.push({
      file: opts.file,
      block_index: at.block_index ?? null,
      clause_id: at.clause_id ?? null,
      path: at.path ?? null,
      message,
    });

  const raw = extractBlocks(markdown);
  if (raw.length === 0) return { ok: true, spec: null };

  const blocks: { block: ObspecBlock; source: string; index: number }[] = [];
  for (const r of raw) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(r.source);
    } catch (e) {
      err(`invalid YAML: ${(e as Error).message}`, { block_index: r.index });
      continue;
    }
    const res = ObspecBlock.safeParse(parsed);
    if (!res.success) {
      for (const issue of res.error.issues)
        err(issue.message, {
          block_index: r.index,
          path: issue.path.join(".") || "(block)",
        });
      continue;
    }
    blocks.push({ block: res.data, source: r.source, index: r.index });
  }
  if (errors.length) return { ok: false, errors };

  const components = blocks.filter((b) => b.block.kind === "component");
  if (components.length !== 1)
    err(
      `spec must declare exactly one component block, found ${components.length}`,
    );
  else if (blocks[0]?.block.kind !== "component")
    err("the component block must be the first obspec block in the file");
  if (errors.length) return { ok: false, errors };
  const component = (components[0] as (typeof blocks)[0])
    .block as ObspecComponent;
  const events = eventSet(component);

  // SPEC-6: mechanical tier escalation, checked at spec time (PRD §7.4). The
  // declared tier is a floor the human may raise but never lower below the
  // mechanical result; an under-declaration is a compile error (not a silent
  // raise, so the file and the stored artifact tier never diverge). T1 when
  // persistent state is mutated by ≥2 distinct event sources; T2 when
  // domains_of_concern touches money/security/data_loss. (Pack-modification
  // T2 has no schema field yet — deferred.)
  const ESCALATION_DOMAINS = new Set(["money", "security", "data_loss"]);
  const TIER_RANK = { T0: 0, T1: 1, T2: 2 } as const;
  const mechanical = ((): { tier: "T1" | "T2"; reason: string } | null => {
    const hit = component.domains_of_concern.filter((d) =>
      ESCALATION_DOMAINS.has(d),
    );
    if (hit.length > 0)
      return {
        tier: "T2",
        reason: `domains_of_concern includes ${hit.join(", ")}`,
      };
    const sources = new Set<string>();
    for (const sv of component.state)
      for (const ev of sv.mutated_by) sources.add(ev);
    if (sources.size >= 2)
      return {
        tier: "T1",
        reason: `persistent state is mutated by ${sources.size} event sources`,
      };
    return null;
  })();
  if (mechanical && TIER_RANK[component.tier] < TIER_RANK[mechanical.tier])
    err(
      `component declares tier ${component.tier} but escalation criteria require ${mechanical.tier} (SPEC-6: ${mechanical.reason}); raise the declared tier — the compiler never lowers below the mechanical result`,
    );

  const domains = new Map<string, ObspecDomain>();
  for (const b of blocks) {
    if (b.block.kind !== "domain") continue;
    if (domains.has(b.block.id))
      err(`duplicate domain id: ${b.block.id}`, { block_index: b.index });
    domains.set(b.block.id, b.block);
  }

  const seenIds = new Set<string>();
  const clauses: CompiledClause[] = [];
  const invariants: CompiledInvariant[] = [];
  let unverifiableCount = 0;

  for (const b of blocks) {
    if (b.block.kind !== "clause" && b.block.kind !== "invariant") continue;
    if (seenIds.has(b.block.id))
      err(`duplicate id: ${b.block.id}`, { block_index: b.index });
    seenIds.add(b.block.id);

    if (b.block.kind === "invariant") {
      const inv = b.block;
      // DSL-5 (structural half): T1+ invariants must reference an existing
      // model file; model-checking itself runs in CI from Phase 4.
      if (component.tier !== "T0") {
        if (!inv.model) {
          err(
            `invariant ${inv.id} requires a formal model at tier ${component.tier}`,
            {
              block_index: b.index,
              clause_id: inv.id,
            },
          );
          continue;
        }
        const modelPath = opts.rootDir
          ? join(opts.rootDir, inv.model)
          : join(dirname(opts.file), inv.model);
        if (!existsSync(modelPath)) {
          err(
            `invariant ${inv.id} references missing model file: ${inv.model}`,
            {
              block_index: b.index,
              clause_id: inv.id,
            },
          );
          continue;
        }
      }
      try {
        const fn = compilePredicate(inv.check);
        invariants.push({
          id: inv.id,
          block_hash: hashContent(b.source),
          model: inv.model,
          probe: (state) => fn(state) === true,
        });
      } catch (e) {
        err(
          `invariant ${inv.id} check failed to compile: ${(e as Error).message}`,
          {
            block_index: b.index,
            clause_id: inv.id,
          },
        );
      }
      continue;
    }

    const clause = b.block as ObspecClause;
    if (
      (clause.ears === "event" || clause.ears === "unwanted") &&
      clause.trigger !== null &&
      !events.has(clause.trigger)
    )
      err(
        `clause ${clause.id} trigger "${clause.trigger}" is not in the component's event set (${[...events].join(", ") || "<empty>"})`,
        { block_index: b.index, clause_id: clause.id },
      );

    for (const [name, ref] of Object.entries(clause.inputs))
      if (!domains.has(ref))
        err(
          `clause ${clause.id} input "${name}" references unknown domain: ${ref}`,
          {
            block_index: b.index,
            clause_id: clause.id,
          },
        );

    // SPEC-1 / SPEC-3 / DSL-4: no parseable check and no signed unverifiable
    // annotation → the clause is vague → the spec is rejected.
    if (clause.check === null && clause.unverifiable === null) {
      err(
        `clause ${clause.id} has no check predicate and no signed unverifiable annotation`,
        { block_index: b.index, clause_id: clause.id },
      );
      continue;
    }

    if (clause.check === null) {
      unverifiableCount++;
      clauses.push({
        id: clause.id,
        tier: component.tier,
        block_hash: hashContent(b.source),
        unverifiable: true,
        makeProperty: null,
      });
      continue;
    }

    const scopeErrors = analyzeCheck(clause.check, {
      inputs: Object.keys(clause.inputs),
      observe: clause.observe,
    });
    for (const msg of scopeErrors)
      err(`clause ${clause.id}: ${msg}`, {
        block_index: b.index,
        clause_id: clause.id,
      });
    if (scopeErrors.length) continue;

    let checkFn: ReturnType<typeof compilePredicate>;
    let preFn: ReturnType<typeof compilePredicate> | null = null;
    let postFn: ReturnType<typeof compilePredicate> | null = null;
    try {
      checkFn = compilePredicate(clause.check);
      if (clause.pre) preFn = compilePredicate(clause.pre);
      if (clause.post) postFn = compilePredicate(clause.post);
    } catch (e) {
      err(
        `clause ${clause.id} check failed to compile: ${(e as Error).message}`,
        {
          block_index: b.index,
          clause_id: clause.id,
        },
      );
      continue;
    }

    const inputEntries = Object.entries(clause.inputs);
    const observe = clause.observe;
    const makeProperty = (harness: ObservationHarness) => {
      const inputsArb = fc.record(
        Object.fromEntries(
          inputEntries.map(([name, ref]) => [
            name,
            domainArbitrary(domains, ref),
          ]),
        ),
      );
      return fc.property(inputsArb, (inputs) => {
        const record = inputs as Record<string, unknown>;
        if (preFn) fc.pre(preFn(record) === true);
        const observed = harness(record) ?? {};
        const ctx = buildContext(record, observed, observe);
        if (checkFn(ctx) !== true) return false;
        if (postFn)
          return (
            postFn({
              ...record,
              state: observed.state,
              state_prime: observed.state_prime,
            }) === true
          );
        return true;
      });
    };

    clauses.push({
      id: clause.id,
      tier: component.tier,
      block_hash: hashContent(b.source),
      unverifiable: false,
      makeProperty,
    });
  }

  // Generator derivation must fail at compile, not first property run (DSL-2).
  for (const id of domains.keys()) {
    try {
      domainArbitrary(domains, id);
    } catch (e) {
      err((e as Error).message);
    }
  }

  if (errors.length) return { ok: false, errors };

  const clauseCount = clauses.length;
  const manifest: ObspecManifest = {
    spec_path: opts.file,
    component: component.id,
    spec_hash: hashContent(markdown),
    entries: [
      ...clauses.map((c) => ({
        clause_id: c.id,
        kind: "clause" as const,
        block_hash: c.block_hash,
        obligation_target: `test/obligations/${c.id}.test.ts`,
        tier: component.tier,
      })),
      ...invariants.map((i) => ({
        clause_id: i.id,
        kind: "invariant" as const,
        block_hash: i.block_hash,
        obligation_target: i.model ?? `probe:${i.id}`,
        tier: component.tier,
      })),
    ],
    unverifiable_ratio: clauseCount === 0 ? 0 : unverifiableCount / clauseCount,
  };

  return {
    ok: true,
    spec: {
      file: opts.file,
      component,
      domains,
      clauses,
      invariants,
      manifest,
    },
  };
};

// DSL-6: each fenced block hashes independently, so clause-level staleness
// (ART-2) works without whole-file churn. Clause artifacts deliberately carry
// no upstream link to the spec file — a file-level link would flag every
// clause on any prose edit, breaking the "exactly its downstream" round-trip.
export const ingestManifest = (
  db: Database,
  repo: string,
  manifest: ObspecManifest,
  authority: ObspecComponent["authority"] = "authored",
): string[] => {
  const now = new Date().toISOString();
  const upsert = db.query(
    `INSERT INTO artifact (repo, logical_id, type, content_hash, authority, tier, created_at, updated_at)
     VALUES (?, ?, 'spec', ?, ?, ?, ?, ?)
     ON CONFLICT (repo, logical_id) DO UPDATE SET
       content_hash = excluded.content_hash, authority = excluded.authority,
       tier = excluded.tier, updated_at = excluded.updated_at`,
  );
  const ids: string[] = [];
  db.transaction(() => {
    upsert.run(
      repo,
      manifest.spec_path,
      manifest.spec_hash,
      authority,
      "T0",
      now,
      now,
    );
    for (const entry of manifest.entries) {
      const logicalId = `${manifest.spec_path}#${entry.clause_id}`;
      upsert.run(
        repo,
        logicalId,
        entry.block_hash,
        authority,
        entry.tier,
        now,
        now,
      );
      ids.push(logicalId);
    }
  })();
  return ids;
};
