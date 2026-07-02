import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, registerArtifact } from "@kelson/kernel";

// Seeds this repo's spec suite into the artifact store so PostToolUse edits
// surface ART-2 staleness (Phase 0 exit criterion). Idempotent — registration
// is an upsert. Run: bun packages/cc-plugin/src/register.ts
const PRD = "docs/specs/2026-07-02-agent-harness-prd.md";
const ERD = "docs/specs/2026-07-02-agent-harness-erd.md";
const SPECS = [
  "docs/specs/2026-07-02-agent-harness-ux.md",
  "docs/specs/2026-07-02-kelspec-dsl.md",
  "docs/specs/2026-07-02-pack-format.md",
  "docs/specs/2026-07-02-eval-procedure.md",
  "docs/specs/2026-07-02-routing-policy.md",
  "docs/specs/2026-07-02-signal-contract.md",
];

if (import.meta.main) {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = openDb(join(root, ".kelson", "kelson.db"));
  registerArtifact(db, {
    repo: root,
    logical_id: PRD,
    type: "prd",
    content: readFileSync(join(root, PRD)),
  });
  registerArtifact(db, {
    repo: root,
    logical_id: ERD,
    type: "erd",
    content: readFileSync(join(root, ERD)),
    upstream: [PRD],
  });
  for (const path of SPECS)
    registerArtifact(db, {
      repo: root,
      logical_id: path,
      type: "spec",
      content: readFileSync(join(root, path)),
      upstream: [PRD],
    });
  console.log(`registered ${2 + SPECS.length} artifacts in ${root}`);
  db.close();
}
