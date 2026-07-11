// SessionEnd → TEL-1: parse the transcript and emit a step event per unique
// assistant message id, then promote the session. If SessionStart never ran,
// or its marker points at a session the store no longer knows (db recreated
// mid-session), a fresh session is begun so the transcript is never lost.
// KERN-1: telemetry must never break the session — everything (imports
// included) stays inside the try; always exit 0.
try {
  const { existsSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { openDb } = await import("@obligato/kernel");
  const { beginSession, finishSession } = await import("../src/session.ts");

  const input = JSON.parse(await Bun.stdin.text()) as {
    session_id?: string;
    transcript_path?: string;
  };
  if (input.transcript_path && existsSync(input.transcript_path)) {
    const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const db = openDb(join(root, ".obligato", "obligato.db"));
    const marker = join(
      root,
      ".obligato",
      "runtime",
      `session-${input.session_id}`,
    );
    const markerId = existsSync(marker)
      ? readFileSync(marker, "utf8").trim()
      : null;
    const known =
      markerId &&
      db.query("SELECT 1 FROM session WHERE id = ?").get(markerId) !== null;
    const sessionId = known ? (markerId as string) : beginSession(db, root);
    rmSync(marker, { force: true });
    finishSession(db, sessionId, readFileSync(input.transcript_path, "utf8"));
    db.close();
  }
} catch {
  /* KERN-1 */
}
process.exit(0);
