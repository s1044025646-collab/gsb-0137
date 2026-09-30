import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.js";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/**
 * Open the SQLite database and run idempotent migrations. Safe to call
 * repeatedly and after a process restart.
 */
export function openDatabase(path: string, clock: Clock = systemClock): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  migrate(db, clock);
  return db;
}

export function migrate(db: DatabaseSync, clock: Clock = systemClock): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.exec.bind(db);
    tx("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        clock.now().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Run work inside a transaction; rolls back on throw. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
