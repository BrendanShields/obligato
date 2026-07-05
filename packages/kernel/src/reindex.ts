import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { IndexRebuildResult } from "@kelson/schemas";
import { diskHashSource } from "./artifacts.ts";
import { compileSpec } from "./kelspec.ts";

// UX-26: reconcile the artifact index against the files of record. Count
// semantics are divergence-pinned (F-151): ingested = new row from the files
// of record; changed = covered row whose recomputed hash differs (overwritten
// in place, authority preserved — promotion state lives only in the store);
// discrepancy = covered row the files no longer regenerate, deleted only when
// provably spec-derived (logical_id naming a *.spec.md source), dangling
// trace links included. Rows outside the covered universe are untouched and
// uncounted. Enumeration is a filesystem scan — the kernel carries no git
// dependency (re-pin vs both blind readers' git-index reading).

const SCAN_EXCLUDES = new Set([".git", "node_modules", ".kelson"]);

const walkSpecFiles = (rootDir: string): string[] => {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDES.has(entry.name)) visit(join(dir, entry.name));
        continue;
      }
      if (entry.name.endsWith(".spec.md"))
        found.push(relative(rootDir, join(dir, entry.name)));
    }
  };
  visit(rootDir);
  return found.sort();
};

export type RebuildSummary = Omit<IndexRebuildResult, "schema_version">;

export const rebuildIndex = (
  db: Database,
  repo: string,
  rootDir: string,
): RebuildSummary => {
  // Compile everything BEFORE any write: a broken kelspec source aborts the
  // whole rebuild with the store unchanged (UX-26 — operator error, not a
  // discrepancy).
  const desired = new Map<
    string,
    { hash: string; tier: string; authority: string }
  >();
  for (const rel of walkSpecFiles(rootDir)) {
    const result = compileSpec(readFileSync(join(rootDir, rel), "utf8"), {
      file: rel,
    });
    if (!result.ok)
      throw new Error(
        `index rebuild aborted: ${rel} failed to compile (${result.errors
          .map((e) => e.message)
          .join("; ")}) — store unchanged`,
      );
    if (result.spec === null) continue; // prose-only file: no blocks, no rows
    const { manifest, component } = result.spec;
    desired.set(manifest.spec_path, {
      hash: manifest.spec_hash,
      tier: "T0",
      authority: component.authority,
    });
    for (const entry of manifest.entries)
      desired.set(`${manifest.spec_path}#${entry.clause_id}`, {
        hash: entry.block_hash,
        tier: entry.tier,
        authority: component.authority,
      });
  }

  const summary: RebuildSummary = { ingested: 0, changed: 0, discrepancies: 0 };
  const source = diskHashSource(rootDir);
  db.transaction(() => {
    const now = new Date().toISOString();
    const existing = db
      .query(
        "SELECT logical_id, content_hash FROM artifact WHERE repo = ? ORDER BY rowid",
      )
      .all(repo) as { logical_id: string; content_hash: string }[];
    const existingHash = new Map(
      existing.map((r) => [r.logical_id, r.content_hash]),
    );

    for (const [logicalId, want] of desired) {
      const have = existingHash.get(logicalId);
      if (have === undefined) {
        db.query(
          `INSERT INTO artifact (repo, logical_id, type, content_hash, authority, tier, created_at, updated_at)
           VALUES (?, ?, 'spec', ?, ?, ?, ?, ?)`,
        ).run(repo, logicalId, want.hash, want.authority, want.tier, now, now);
        summary.ingested++;
      } else if (have !== want.hash) {
        // hash overwritten in place; authority stays — a promoted clause must
        // not be demoted by a rebuild (promotion exists only in the store)
        db.query(
          "UPDATE artifact SET content_hash = ?, tier = ?, updated_at = ? WHERE repo = ? AND logical_id = ?",
        ).run(want.hash, want.tier, now, repo, logicalId);
        summary.changed++;
      }
    }

    for (const row of existing) {
      if (desired.has(row.logical_id)) continue;
      const sourcePath = row.logical_id.split("#")[0] as string;
      if (sourcePath.endsWith(".spec.md")) {
        // provably spec-derived and no longer regenerated → discrepancy
        db.query("DELETE FROM artifact WHERE repo = ? AND logical_id = ?").run(
          repo,
          row.logical_id,
        );
        summary.discrepancies++;
        const links = db
          .query(
            "SELECT id FROM trace_link WHERE repo = ? AND (upstream_id = ? OR downstream_id = ?)",
          )
          .all(repo, row.logical_id, row.logical_id) as { id: string }[];
        for (const link of links) {
          db.query("DELETE FROM trace_link WHERE id = ?").run(link.id);
          summary.discrepancies++;
        }
        continue;
      }
      if (row.logical_id.includes("#")) continue; // opaque id: uncovered
      const hash = source(row.logical_id);
      if (hash === null) continue; // unresolvable: outside the covered universe
      if (hash !== row.content_hash) {
        db.query(
          "UPDATE artifact SET content_hash = ?, updated_at = ? WHERE repo = ? AND logical_id = ?",
        ).run(hash, now, repo, row.logical_id);
        summary.changed++;
      }
    }
  })();
  return summary;
};
