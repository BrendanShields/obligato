import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DB_PATH = join(homedir(), ".obligato", "obligato.db");
export const KERNEL_MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const loadMigrations = (dir: string): Migration[] => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const migrations = files.map((f) => {
    const version = Number.parseInt(f, 10);
    if (!Number.isInteger(version) || version < 1)
      throw new Error(
        `migration filename must start with a positive number: ${f}`,
      );
    return { version, name: f, sql: readFileSync(join(dir, f), "utf8") };
  });
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length)
    throw new Error(`duplicate migration versions in ${dir}`);
  return migrations;
};

export const migrate = (db: Database, dir: string): number[] => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const migrations = loadMigrations(dir);
  const current =
    (
      db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as {
        v: number | null;
      }
    ).v ?? 0;
  const available = Math.max(0, ...migrations.map((m) => m.version));
  if (current > available)
    throw new Error(
      `store schema version ${current} is newer than this kernel's migrations (${available}) — refusing (OSS-6: never silently coerce)`,
    );
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  const applied: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  return applied;
};

export const openDb = (
  path = DEFAULT_DB_PATH,
  migrationsDir = KERNEL_MIGRATIONS_DIR,
): Database => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db, migrationsDir);
  return db;
};
