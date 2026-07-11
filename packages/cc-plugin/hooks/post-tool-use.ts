// PostToolUse (Edit|Write) → ART-2: rehash registered artifacts from disk and
// flag transitively stale downstreams (Phase 0 exit criterion: editing a spec
// surfaces trace-link staleness).
// KERN-1: telemetry must never break the session — everything (imports
// included) stays inside the try; always exit 0.
try {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { detectStaleness, openDb, rehashFromDisk } = await import(
    "@obligato/kernel"
  );

  const input = JSON.parse(await Bun.stdin.text()) as {
    tool_input?: { file_path?: string };
  };
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const dbPath = join(root, ".obligato", "obligato.db");
  if (input.tool_input?.file_path && existsSync(dbPath)) {
    const db = openDb(dbPath);
    rehashFromDisk(db, root, root);
    detectStaleness(db, root);
    db.close();
  }
} catch {
  /* KERN-1 */
}
process.exit(0);
