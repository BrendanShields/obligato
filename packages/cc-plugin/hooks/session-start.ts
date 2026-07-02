// SessionStart → open the store, begin a kernel session pinned to the current
// lockfile hash, remember the mapping for session-end.
// KERN-1: telemetry must never break the session — everything (imports
// included, which fail on a fresh clone before `bun install`) stays inside
// the try; always exit 0.
try {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { openDb } = await import("@kelson/kernel");
  const { beginSession } = await import("../src/session.ts");

  const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string };
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = openDb(join(root, ".kelson", "kelson.db"));
  const id = beginSession(db, root);
  db.close();
  if (input.session_id) {
    const runtime = join(root, ".kelson", "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, `session-${input.session_id}`), id);
  }
} catch {
  /* KERN-1 */
}
process.exit(0);
