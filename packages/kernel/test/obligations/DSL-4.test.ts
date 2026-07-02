import { describe, expect, it } from "bun:test";
import { compileSpec } from "../../src/kelspec.ts";

const md = (clauseBody: string) => `\`\`\`kelspec
kind: component
id: widget
tier: T0
authority: authored
events: [poked]
\`\`\`

\`\`\`kelspec
kind: clause
id: WID-1
ears: event
trigger: poked
text: When poked, the widget shall respond.
${clauseBody}\`\`\`
`;

describe("DSL-4: a clause with no check and no signed unverifiable annotation rejects the spec listing that clause ID", () => {
  it("an unannotated checkless clause is rejected by ID", () => {
    const res = compileSpec(md(""), { file: "checkless.spec.md" });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(
        res.errors.some(
          (e) => e.clause_id === "WID-1" && e.message.includes("unverifiable"),
        ),
      ).toBe(true);
  });

  it("a signed unverifiable annotation passes at the grammar level", () => {
    const res = compileSpec(
      md(
        "unverifiable:\n  signed_by: brendan\n  reason: no observable surface\n",
      ),
      { file: "signed.spec.md" },
    );
    expect(res.ok).toBe(true);
  });

  it("an unsigned annotation object is malformed, not a pass", () => {
    const res = compileSpec(md("unverifiable:\n  reason: just because\n"), {
      file: "unsigned.spec.md",
    });
    expect(res.ok).toBe(false);
  });
});
