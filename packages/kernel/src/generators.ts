import type { ObspecDomain } from "@obligato/schemas";
import fc from "fast-check";

// SPEC-2 / DSL-2: every constraint on a domain block is generator-facing —
// the arbitrary is derived from exactly the declared fields, nothing else.
export const domainArbitrary = (
  domains: ReadonlyMap<string, ObspecDomain>,
  ref: string,
  seen: readonly string[] = [],
): fc.Arbitrary<unknown> => {
  const d = domains.get(ref);
  if (!d) throw new Error(`unknown domain: ${ref}`);
  if (seen.includes(ref))
    throw new Error(`cyclic domain reference: ${[...seen, ref].join(" -> ")}`);
  const sub = (r: string) => domainArbitrary(domains, r, [...seen, ref]);
  switch (d.type) {
    case "int":
      return fc.integer({ min: d.min, max: d.max });
    case "float":
      return fc.double({ min: d.min, max: d.max, noNaN: true });
    case "string": {
      // ponytail: JS RegExp stands in for the spec's RE2 — revisit if a pack
      // ships a pattern the two engines disagree on.
      const base = d.pattern
        ? fc.stringMatching(new RegExp(d.pattern))
        : fc.string({ maxLength: d.max_length ?? 64 });
      return d.pattern && d.max_length !== null
        ? base.filter((s) => s.length <= (d.max_length as number))
        : base;
    }
    case "enum":
      return fc.constantFrom(...d.values);
    case "struct":
      return fc.record(
        Object.fromEntries(
          Object.entries(d.fields).map(([name, r]) => [name, sub(r)]),
        ),
      );
    case "list":
      return fc.array(sub(d.of), { maxLength: d.max_items });
    case "map": {
      const keyDomain = domains.get(d.keys);
      if (
        !keyDomain ||
        (keyDomain.type !== "string" && keyDomain.type !== "enum")
      )
        throw new Error(
          `map domain ${d.id} requires a string or enum key domain, got: ${keyDomain?.type ?? "unknown"}`,
        );
      return fc.dictionary(sub(d.keys) as fc.Arbitrary<string>, sub(d.values), {
        maxKeys: d.max_items,
      });
    }
  }
};
