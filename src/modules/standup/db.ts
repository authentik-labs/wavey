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
  {
    // Membership of the destination channel now decides who participates, so this
    // column stopped meaning "the user wants standups" and started meaning "the
    // user is in the channel". Only the membership sync writes it.
    name: "standup.002_membership",
    sql: `ALTER TABLE standup_users RENAME COLUMN enabled TO in_channel;`,
  },
  {
    // Lets the Slack-profile backfill tell "nobody ever chose this timezone" from "the
    // user typed exactly this". Existing rows are 'default' by construction, which is
    // precisely the set the backfill is allowed to touch.
    name: "standup.003_timezone_source",
    sql: `ALTER TABLE standup_users ADD COLUMN timezone_source TEXT NOT NULL DEFAULT 'default';`,
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

/** Everyone currently in the destination channel - the people the tick prompts. */
export function listActiveUsers(db: Database.Database): StandupUserRow[] {
  return db.prepare("SELECT * FROM standup_users WHERE in_channel = 1").all() as StandupUserRow[];
}

/** The user_ids the DB believes are in the channel - the left side of the sync's diff. */
export function listInChannelUserIds(db: Database.Database): string[] {
  const rows = db.prepare("SELECT user_id FROM standup_users WHERE in_channel = 1").all() as {
    user_id: string;
  }[];
  return rows.map((row) => row.user_id);
}

/**
 * Marks a user as in the destination channel, creating their row from the config
 * defaults the first time. Returns true only for the 0 -> 1 transition, so however
 * many join events and reconciles race each other, exactly one of them sends the
 * welcome DM. Same claim shape as claimEntry below.
 *
 * `profileTimezone` is their Slack profile's zone when we have a valid one; it beats
 * the workspace default because it's about this person rather than about the team.
 *
 * The DO UPDATE deliberately touches only in_channel: a rejoin must not reset the
 * timezone and send time the person picked last time round.
 */
export function claimJoin(
  db: Database.Database,
  userId: string,
  defaults: Omit<StandupConfigRow, "id" | "channel_id" | "updated_at">,
  profileTimezone?: string,
): boolean {
  const result = db
    .prepare(
      `INSERT INTO standup_users (user_id, timezone, timezone_source, send_time, reminder_minutes, in_channel, updated_at)
       VALUES (@user_id, @timezone, @timezone_source, @send_time, @reminder_minutes, 1, @updated_at)
       ON CONFLICT (user_id) DO UPDATE SET
         in_channel = 1,
         updated_at = excluded.updated_at
       WHERE standup_users.in_channel = 0`,
    )
    .run({
      user_id: userId,
      timezone: profileTimezone ?? defaults.default_timezone,
      timezone_source: profileTimezone ? "slack" : "default",
      send_time: defaults.default_send_time,
      reminder_minutes: defaults.default_reminder_minutes,
      updated_at: new Date().toISOString(),
    });
  return result.changes === 1;
}

/**
 * Adopts a Slack profile's timezone for someone who never chose one. The WHERE clause is
 * the entire safety argument - a row that reached 'slack' or 'user' is left alone - so it
 * stays in the statement rather than becoming a read-then-write the sweep could race.
 *
 * Returns true only when a row actually changed, which also makes this self-extinguishing:
 * one successful adopt takes the user out of listUserIdsNeedingTimezone for good.
 */
export function adoptProfileTimezone(db: Database.Database, userId: string, timezone: string): boolean {
  const result = db
    .prepare(
      `UPDATE standup_users
       SET timezone = ?, timezone_source = 'slack', updated_at = ?
       WHERE user_id = ? AND timezone_source = 'default'`,
    )
    .run(timezone, new Date().toISOString(), userId);
  return result.changes === 1;
}

/** Participants still on an inherited timezone - the backfill's work list. */
export function listUserIdsNeedingTimezone(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT user_id FROM standup_users WHERE in_channel = 1 AND timezone_source = 'default'")
    .all() as { user_id: string }[];
  return rows.map((row) => row.user_id);
}

/**
 * Soft removal - keeps their timezone and send time for when they rejoin. Returns
 * true only for the 1 -> 0 transition, so the log records real departures.
 */
export function markLeft(db: Database.Database, userId: string): boolean {
  const result = db
    .prepare("UPDATE standup_users SET in_channel = 0, updated_at = ? WHERE user_id = ? AND in_channel = 1")
    .run(new Date().toISOString(), userId);
  return result.changes === 1;
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
      timezone_source: "default",
      send_time: defaults.default_send_time,
      reminder_minutes: defaults.default_reminder_minutes,
      // Only claimJoin grants membership. A row born here - someone saving their
      // settings - must not enrol them, or /standup-time becomes a way to opt in
      // without being in the channel. (The renamed column still carries DEFAULT 1,
      // so this has to be explicit.)
      in_channel: 0,
      updated_at: new Date().toISOString(),
    } as StandupUserRow);
  const next: StandupUserRow = { ...current, ...patch, user_id: userId, updated_at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO standup_users (user_id, timezone, timezone_source, send_time, reminder_minutes, in_channel, updated_at)
     VALUES (@user_id, @timezone, @timezone_source, @send_time, @reminder_minutes, @in_channel, @updated_at)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = excluded.timezone,
       timezone_source = excluded.timezone_source,
       send_time = excluded.send_time,
       reminder_minutes = excluded.reminder_minutes,
       in_channel = excluded.in_channel,
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

/**
 * The user's most recent submitted standup from before `beforeDate`, shown as
 * reference when they fill out a new one.
 *
 * Filters on status rather than on the answer columns: an unsubmitted entry has all
 * three NULL, but a submitted one can legitimately have NULL blockers. entry_date is
 * YYYY-MM-DD, so sorting it lexically is sorting it chronologically.
 */
export function getPreviousSubmittedEntry(
  db: Database.Database,
  userId: string,
  beforeDate: string,
): StandupEntryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM standup_entries
       WHERE user_id = ? AND entry_date < ? AND status = 'submitted'
       ORDER BY entry_date DESC
       LIMIT 1`,
    )
    .get(userId, beforeDate) as StandupEntryRow | undefined;
}

/**
 * Claims today's entry for a user: inserts it, or returns undefined if one already
 * existed. The insert is the arbiter, so a caller that only sends its prompt DM when
 * it gets a row back can't double-send however many ticks or processes race it.
 */
export function claimEntry(
  db: Database.Database,
  userId: string,
  entryDate: string,
  dmChannelId: string,
): StandupEntryRow | undefined {
  const result = db
    .prepare(
      `INSERT INTO standup_entries (user_id, entry_date, status, prompted_at, dm_channel_id)
       VALUES (?, ?, 'prompted', ?, ?)
       ON CONFLICT (user_id, entry_date) DO NOTHING`,
    )
    .run(userId, entryDate, new Date().toISOString(), dmChannelId);
  return result.changes === 1 ? getEntryById(db, Number(result.lastInsertRowid)) : undefined;
}

/** The entry for this user and day, creating it if absent. For flows that just want the row. */
export function getOrCreateEntry(
  db: Database.Database,
  userId: string,
  entryDate: string,
  dmChannelId: string,
): StandupEntryRow {
  return claimEntry(db, userId, entryDate, dmChannelId) ?? getEntry(db, userId, entryDate)!;
}

/**
 * Claims the reminder for an entry. Returns false if it wasn't in 'prompted' state -
 * already reminded, already submitted, or claimed by a concurrent tick - in which case
 * the caller must not send a reminder DM.
 */
export function markReminded(db: Database.Database, id: number): boolean {
  const result = db
    .prepare("UPDATE standup_entries SET status = 'reminded', reminded_at = ? WHERE id = ? AND status = 'prompted'")
    .run(new Date().toISOString(), id);
  return result.changes === 1;
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
