import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPack } from "../../src/packs.ts";

const manifest = (capabilities: string[], kernel_compat = ">=0.1 <2") =>
  [
    "schema_version: 1",
    "name: fixture",
    "version: 1.0.0",
    "kind: efficiency",
    `kernel_compat: "${kernel_compat}"`,
    `capabilities: [${capabilities.join(", ")}]`,
    "description: fixture pack",
  ].join("\n");

const writePack = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "obligato-pack-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe("PACK-1 / SEC-4: deterministic path→capability mapping, undeclared capability refused", () => {
  const mapping: [string, string][] = [
    ["rules/no-comments.md", "rules"],
    ["skills/build/tdd.md", "stage:build"],
    ["skills/spec/ears.md", "stage:spec"],
    ["routing/table.yaml", "routing-table"],
    ["agents/reviewer.yaml", "agent-registry"],
    ["context/heuristics.yaml", "context-assembly"],
    ["suites/bench.yaml", "eval-suite"],
  ];

  for (const [path, cap] of mapping) {
    it(`${path} loads when ${cap} is declared, refused naming file + capability when not`, () => {
      const files = { "pack.yaml": manifest([cap]), [path]: "x" };
      expect(loadPack(writePack(files)).manifest.capabilities).toEqual([
        cap as never,
      ]);

      const undeclared = {
        "pack.yaml": manifest([cap === "rules" ? "eval-suite" : "rules"]),
        [path]: "x",
      };
      expect(() => loadPack(writePack(undeclared))).toThrow(
        new RegExp(`${path}.*"${cap}"`),
      );
    });
  }

  it("a skill file directly under skills/ is a layout error, refused", () => {
    const dir = writePack({
      "pack.yaml": manifest(["stage:build"]),
      "skills/orphan.md": "x",
    });
    expect(() => loadPack(dir)).toThrow(
      /skills\/orphan\.md.*layout error|layout error.*skills\/orphan\.md/,
    );
  });

  it("an unknown stage directory under skills/ is refused", () => {
    const dir = writePack({
      "pack.yaml": manifest(["stage:build"]),
      "skills/deploy/ship.md": "x",
    });
    expect(() => loadPack(dir)).toThrow(/skills\/deploy/);
  });

  it("rules-only content with only a stage capability is refused — neither substitutes for the other", () => {
    const dir = writePack({
      "pack.yaml": manifest(["stage:build"]),
      "rules/terse.md": "x",
    });
    expect(() => loadPack(dir)).toThrow(/rules\/terse\.md.*"rules"/);
  });

  it("an unmapped path is refused fail-closed, naming the file", () => {
    const dir = writePack({
      "pack.yaml": manifest(["rules"]),
      "extras/notes.md": "x",
    });
    expect(() => loadPack(dir)).toThrow(/extras\/notes\.md/);
  });

  it("pack.yaml and pack.sig require no capability", () => {
    const dir = writePack({
      "pack.yaml": manifest(["rules"]),
      "pack.sig": "stub-signature",
      "rules/r.md": "x",
    });
    expect(loadPack(dir).manifest.name).toBe("fixture");
  });

  it("kernel_compat must be a semver range (F-007): non-range refused, range accepted", () => {
    const bad = writePack({
      "pack.yaml": manifest(["rules"], "whatever works"),
      "rules/r.md": "x",
    });
    expect(() => loadPack(bad)).toThrow();

    for (const range of ["*", ">=0.1 <2", "^1.2.0", "1.x", ">=1 || <0.2"]) {
      const good = writePack({
        "pack.yaml": manifest(["rules"], range),
        "rules/r.md": "x",
      });
      expect(loadPack(good).manifest.kernel_compat).toBe(range);
    }
  });
});
