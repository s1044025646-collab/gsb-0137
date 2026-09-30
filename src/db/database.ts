import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";

export type DB = DatabaseSync;

/** Run `fn` inside a transaction, rolling back on throw. */
export function withTransaction<T>(db: DB, fn: () => T): T {
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

/** Open a database and apply migrations. Migrations are idempotent. */
export function openDatabase(
  path: string,
  now: () => string = () => new Date().toISOString(),
): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db, now);
  return db;
}

export function migrate(db: DB, now: () => string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as
    Array<{ id: number }>;
  const applied = new Set(appliedRows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    withTransaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(id, applied_at) VALUES(?,?)")
        .run(m.id, now());
    });
  }
}

export function closeDatabase(db: DB): void {
  db.close();
}
