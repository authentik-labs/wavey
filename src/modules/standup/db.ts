import type Database from "better-sqlite3";
import type { Migration } from "../../core/db.js";
import type { EntryStatus, StandupConfigRow, StandupEntryRow, StandupUserRow } from "./types.js";

export const migrations: Migration[] = [
  {
    name: "standup.001_init",
    sql: `
      CREATE TABLE standup_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_id TEXT,
        default_timezone TEXT NOT NULL DEFAULT 'UTC',
        default_send_time TEXT NOT NULL DEFAULT '09:00',
        default_reminder_minutes INTEGER NOT NULL DEFAULT 120,
        skip_weekends INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE standup_users (
        user_id TEXT PRIMARY KEY,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        send_time TEXT NOT NULL DEFAULT '09:00',
        reminder_minutes INTEGER NOT NULL DEFAULT 120,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE standup_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prompted',
        prompted_at TEXT NOT NULL,
        reminded_at TEXT,
        submitted_at TEXT,
        yesterday TEXT,
        today TEXT,
        blockers TEXT,
        dm_channel_id TEXT NOT NULL,
        prompt_message_ts TEXT,
        posted_message_ts TEXT,
        UNIQUE (user_id, entry_date)
      );
    `,
  },
];

export function getConfig(db: Database.Database): StandupConfigRow | undefined {
  return db.prepare("SELECT * FROM standup_config WHERE id = 1").get() as StandupConfigRow | undefined;
}

const DEFAULT_CONFIG: Omit<StandupConfigRow, "id" | "updated_at"> = {
  channel_id: null,
  default_timezone: "UTC",
  default_send_time: "09:00",
  default_reminder_minutes: 120,
  skip_weekends: 1,
};

export function getConfigOrDefault(db: Database.Database): StandupConfigRow {
  return getConfig(db) ?? { id: 1, updated_at: new Date().toISOString(), ...DEFAULT_CONFIG };
}

export function upsertConfig(
  db: Database.Database,
  patch: Partial<Omit<StandupConfigRow, "id" | "updated_at">>,
): StandupConfigRow {
  const current = getConfigOrDefault(db);
  const next: StandupConfigRow = { ...current, ...patch, id: 1, updated_at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO standup_config (id, channel_id, default_timezone, default_send_time, default_reminder_minutes, skip_weekends, updated_at)
     VALUES (1, @channel_id, @default_timezone, @default_send_time, @default_reminder_minutes, @skip_weekends, @updated_at)
     ON CONFLICT (id) DO UPDATE SET
       channel_id = excluded.channel_id,
       default_timezone = excluded.default_timezone,
       default_send_time = excluded.default_send_time,
       default_reminder_minutes = excluded.default_reminder_minutes,
       skip_weekends = excluded.skip_weekends,
       updated_at = excluded.updated_at`,
  ).run(next);
  return next;
}

export function getUser(db: Database.Database, userId: string): StandupUserRow | undefined {
  return db.prepare("SELECT * FROM standup_users WHERE user_id = ?").get(userId) as StandupUserRow | undefined;
}

export function listEnabledUsers(db: Database.Database): StandupUserRow[] {
  return db.prepare("SELECT * FROM standup_users WHERE enabled = 1").all() as StandupUserRow[];
}

export function upsertUser(
  db: Database.Database,
  userId: string,
  patch: Partial<Omit<StandupUserRow, "user_id" | "updated_at">>,
  defaults: Omit<StandupConfigRow, "id" | "channel_id" | "updated_at">,
): StandupUserRow {
  const current: StandupUserRow =
    getUser(db, userId) ??
    ({
      user_id: userId,
      timezone: defaults.default_timezone,
      send_time: defaults.default_send_time,
      reminder_minutes: defaults.default_reminder_minutes,
      enabled: 1,
      updated_at: new Date().toISOString(),
    } as StandupUserRow);
  const next: StandupUserRow = { ...current, ...patch, user_id: userId, updated_at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO standup_users (user_id, timezone, send_time, reminder_minutes, enabled, updated_at)
     VALUES (@user_id, @timezone, @send_time, @reminder_minutes, @enabled, @updated_at)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = excluded.timezone,
       send_time = excluded.send_time,
       reminder_minutes = excluded.reminder_minutes,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(next);
  return next;
}

export function getEntry(db: Database.Database, userId: string, entryDate: string): StandupEntryRow | undefined {
  return db
    .prepare("SELECT * FROM standup_entries WHERE user_id = ? AND entry_date = ?")
    .get(userId, entryDate) as StandupEntryRow | undefined;
}

export function getEntryById(db: Database.Database, id: number): StandupEntryRow | undefined {
  return db.prepare("SELECT * FROM standup_entries WHERE id = ?").get(id) as StandupEntryRow | undefined;
}

export function createEntry(
  db: Database.Database,
  userId: string,
  entryDate: string,
  dmChannelId: string,
  promptMessageTs: string | undefined,
): StandupEntryRow {
  const promptedAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO standup_entries (user_id, entry_date, status, prompted_at, dm_channel_id, prompt_message_ts)
       VALUES (?, ?, 'prompted', ?, ?, ?)`,
    )
    .run(userId, entryDate, promptedAt, dmChannelId, promptMessageTs ?? null);
  return getEntryById(db, Number(result.lastInsertRowid))!;
}

export function markReminded(db: Database.Database, id: number): void {
  db.prepare("UPDATE standup_entries SET status = 'reminded', reminded_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

export function submitEntry(
  db: Database.Database,
  id: number,
  fields: { yesterday: string; today: string; blockers: string | null },
  postedMessageTs: string | undefined,
): void {
  db.prepare(
    `UPDATE standup_entries
     SET status = 'submitted', submitted_at = ?, yesterday = ?, today = ?, blockers = ?, posted_message_ts = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), fields.yesterday, fields.today, fields.blockers, postedMessageTs ?? null, id);
}

export function setPromptMessageTs(db: Database.Database, id: number, ts: string): void {
  db.prepare("UPDATE standup_entries SET prompt_message_ts = ? WHERE id = ?").run(ts, id);
}

export type { EntryStatus };
