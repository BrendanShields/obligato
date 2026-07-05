import { describe, expect, it } from "bun:test";
import { compileSpec } from "../../src/kelspec.ts";

const spec = (body: string) => `\`\`\`kelspec\n${body.trim()}\n\`\`\`\n`;
const compile = (body: string) =>
  compileSpec(spec(body), { file: "t.spec.md" });
const messages = (body: string) => {
  const r = compile(body);
  return r.ok ? [] : r.errors.map((e) => e.message);
};

describe("SPEC-6: mechanical tier escalation rejects an under-declaration; a raise is honored", () => {
  it("persistent state mutated by ≥2 event sources declared T0 is rejected, requiring T1", () => {
    const msgs = messages(`
kind: component
id: stateful
tier: T0
authority: authored
state:
  - name: counter
    mutated_by: [inc, dec]
events: [inc, dec]
`);
    expect(msgs.some((m) => m.includes("require T1"))).toBe(true);
    expect(msgs.some((m) => m.includes("2 event sources"))).toBe(true);
  });

  it("domains_of_concern touching money declared T0 is rejected, requiring T2", () => {
    const msgs = messages(`
kind: component
id: money-mover
tier: T0
authority: authored
domains_of_concern: [money]
`);
    expect(
      msgs.some((m) => m.includes("require T2") && m.includes("money")),
    ).toBe(true);
  });

  it("a single-source state variable does not escalate — declared T0 compiles", () => {
    const r = compile(`
kind: component
id: simple
tier: T0
authority: authored
state:
  - name: x
    mutated_by: [e]
events: [e]
`);
    expect(r.ok).toBe(true);
  });

  it("a declared tier at the mechanical result compiles (T1 with two event sources)", () => {
    const r = compile(`
kind: component
id: limiter
tier: T1
authority: authored
state:
  - name: w
    mutated_by: [a, b]
events: [a, b]
`);
    expect(r.ok).toBe(true);
  });

  it("a human may raise above the mechanical result (T2 with no escalation criteria)", () => {
    const r = compile(`
kind: component
id: careful
tier: T2
authority: authored
`);
    expect(r.ok).toBe(true);
  });
});
