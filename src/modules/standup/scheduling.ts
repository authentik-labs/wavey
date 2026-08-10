import { DateTime } from "luxon";
import type Database from "better-sqlite3";
import type { App } from "@slack/bolt";
import type { Logger } from "../../core/logger.js";
import {
  createEntry,
  getConfig,
  getEntry,
  listEnabledUsers,
  markReminded,
} from "./db.js";
import type { StandupUserRow } from "./types.js";
import { buildPromptMessage, buildReminderMessage } from "./views.js";

/** YYYY-MM-DD for "now" in the given IANA timezone. */
export function localDate(tz: string, now: Date): string {
  return DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).toISODate()!;
}

function localHHmm(tz: string, now: Date): string {
  return DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).toFormat("HH:mm");
}

function localWeekday(tz: string, now: Date): number {
  // Luxon weekday: 1 = Monday ... 7 = Sunday
  return DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).weekday;
}

/**
 * Runs once per scheduler tick. For every enabled user, sends today's prompt
 * DM if it's at/after their configured send time and one hasn't gone out
 * yet, and sends a single reminder DM if they haven't submitted within
 * their configured reminder window. Both checks are idempotent against
 * standup_entries, so ticking more often than once a minute is harmless.
 */
export async function runStandupTick(app: App, db: Database.Database, logger: Logger, now: Date): Promise<void> {
  const config = getConfig(db);
  if (!config?.channel_id) return; // not configured yet, nothing to do

  const users = listEnabledUsers(db);
  for (const user of users) {
    try {
      await handleUser(app, db, logger, user, config.skip_weekends === 1, now);
    } catch (err) {
      logger.error({ err, userId: user.user_id }, "standup tick failed for user");
    }
  }
}

async function handleUser(
  app: App,
  db: Database.Database,
  logger: Logger,
  user: StandupUserRow,
  skipWeekends: boolean,
  now: Date,
): Promise<void> {
  const weekday = localWeekday(user.timezone, now);
  if (skipWeekends && weekday >= 6) return;

  const today = localDate(user.timezone, now);
  const existing = getEntry(db, user.user_id, today);

  if (!existing) {
    const currentHHmm = localHHmm(user.timezone, now);
    if (currentHHmm < user.send_time) return; // not due yet today

    const dm = await app.client.conversations.open({ users: user.user_id });
    const dmChannelId = dm.channel?.id;
    if (!dmChannelId) {
      logger.warn({ userId: user.user_id }, "could not open DM channel");
      return;
    }
    const entry = createEntry(db, user.user_id, today, dmChannelId, undefined);
    const posted = await app.client.chat.postMessage({
      channel: dmChannelId,
      ...buildPromptMessage(entry.id),
    });
    if (posted.ts) {
      db.prepare("UPDATE standup_entries SET prompt_message_ts = ? WHERE id = ?").run(posted.ts, entry.id);
    }
    logger.info({ userId: user.user_id, entryId: entry.id }, "sent standup prompt");
    return;
  }

  if (existing.status !== "prompted") return; // already reminded or submitted

  const promptedAt = DateTime.fromISO(existing.prompted_at, { zone: "utc" });
  const dueForReminder = DateTime.fromJSDate(now, { zone: "utc" }) >= promptedAt.plus({ minutes: user.reminder_minutes });
  if (!dueForReminder) return;

  await app.client.chat.postMessage({
    channel: existing.dm_channel_id,
    ...buildReminderMessage(existing.id),
  });
  markReminded(db, existing.id);
  logger.info({ userId: user.user_id, entryId: existing.id }, "sent standup reminder");
}
