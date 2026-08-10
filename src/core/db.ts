import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "./logger.js";

export interface Migration {
  /** Must be globally unique and stable once shipped, e.g. "standup.001_init". */
  name: string;
  sql: string;
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function runMigrations(db: Database.Database, migrations: Migration[], logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((row) => (row as { name: string }).name),
  );

  const markApplied = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      markApplied.run(migration.name, new Date().toISOString());
    });
    apply();
    logger.info({ migration: migration.name }, "applied migration");
  }
}
