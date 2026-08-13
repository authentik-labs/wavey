import type { App } from "@slack/bolt";
import type Database from "better-sqlite3";
import type { Logger } from "../../core/logger.js";
import { claimJoin, getConfig, getConfigOrDefault, listInChannelUserIds, markLeft } from "./db.js";
import type { StandupConfigRow } from "./types.js";

type SlackClient = App["client"];

/** How often the tick does a full sweep. Join/leave events cover the gaps. */
const RECONCILE_INTERVAL_MS = 15 * 60_000;

/** Guards against a cursor bug turning the member fetch into an infinite loop. */
const MAX_PAGES = 100;

/**
 * Above this many new participants in one sweep, announce in the channel instead
 * of DMing everyone - pointing /standup-setup at a big channel shouldn't fire
 * hundreds of DMs at once.
 */
const WELCOME_DM_LIMIT = 20;

/**
 * Bots, apps and deactivated accounts never get a row, so without remembering them
 * we'd spend a users.info call on each one every single sweep. In-memory is enough:
 * a restart just costs one extra lookup per non-human.
 */
const knownNonHumans = new Set<string>();
let lastReconcileAt = 0;
/** Lets a destination-channel switch reconcile immediately instead of waiting out the throttle. */
let lastChannelId: string | undefined;
let cachedBotUserId: string | undefined;

export async function botUserId(client: SlackClient): Promise<string | undefined> {
  if (!cachedBotUserId) cachedBotUserId = (await client.auth.test()).user_id;
  return cachedBotUserId;
}

/** True for real people we should enrol. Caches the negatives. */
async function isHuman(client: SlackClient, logger: Logger, userId: string): Promise<boolean> {
  if (knownNonHumans.has(userId)) return false;
  try {
    const user = (await client.users.info({ user: userId })).user;
    if (!user || user.is_bot || user.deleted || user.is_app_user) {
      knownNonHumans.add(userId);
      return false;
    }
    return true;
  } catch (err) {
    // Don't cache a failure as "not human" - a transient error would exclude a real
    // person until the next restart. Skip them this round and retry next sweep.
    logger.warn({ err, userId }, "could not look up user, skipping this round");
    return false;
  }
}

/** Every member of the channel. Throws rather than returning a partial list. */
async function fetchChannelMembers(client: SlackClient, channel: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.conversations.members({ channel, cursor, limit: 200 });
    members.push(...(result.members ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return members;
}

function welcomeText(config: StandupConfigRow): string {
  return `You've been enrolled in daily standups :wave: I'll DM you at ${config.default_send_time} (${config.default_timezone}) each weekday. Run /standup-time anytime to change your schedule.`;
}

async function sendWelcomeDm(client: SlackClient, logger: Logger, userId: string, config: StandupConfigRow) {
  try {
    const dm = await client.conversations.open({ users: userId });
    const channel = dm.channel?.id;
    if (!channel) return;
    await client.chat.postMessage({ channel, text: welcomeText(config) });
  } catch (err) {
    logger.warn({ err, userId }, "failed to send standup welcome DM");
  }
}

export interface SyncResult {
  enrolled: number;
  removed: number;
}

/**
 * Reconciles standup_users against the destination channel's membership: everyone
 * in the channel is a participant, everyone else isn't.
 */
export async function syncMembership(app: App, db: Database.Database, logger: Logger): Promise<SyncResult> {
  const empty: SyncResult = { enrolled: 0, removed: 0 };
  const config = getConfig(db);
  if (!config?.channel_id) return empty;

  const client = app.client;
  const channel = config.channel_id;

  // Stamped before the work, not after: a permanently broken channel (archived, or
  // one we've been kicked from) should retry on the throttle interval rather than
  // on every 60s tick.
  lastReconcileAt = Date.now();
  lastChannelId = channel;

  let members: string[];
  try {
    members = await fetchChannelMembers(client, channel);
  } catch (err) {
    // Critical: a half-fetched member list is indistinguishable from "everyone left",
    // so a paging failure must not reach the diff below.
    logger.error({ err, channel }, "could not read standup channel members, skipping reconcile");
    return empty;
  }

  if (members.length === 0) {
    // We should at least see ourselves. An empty list means something is wrong with
    // the channel, not that the whole team walked out.
    logger.warn({ channel }, "standup channel reported no members, skipping reconcile");
    return empty;
  }

  const selfId = await botUserId(client);
  const memberIds = new Set(members.filter((id) => id !== selfId));
  const alreadyIn = new Set(listInChannelUserIds(db));

  const newlyEnrolled: string[] = [];
  for (const userId of memberIds) {
    if (alreadyIn.has(userId)) continue;
    if (!(await isHuman(client, logger, userId))) continue;
    if (claimJoin(db, userId, config)) newlyEnrolled.push(userId);
  }

  let removed = 0;
  for (const userId of alreadyIn) {
    if (memberIds.has(userId)) continue;
    if (markLeft(db, userId)) removed++;
  }

  await announceEnrollment(client, logger, newlyEnrolled, config, channel);

  logger.info({ channel, enrolled: newlyEnrolled.length, removed }, "reconciled standup membership");
  return { enrolled: newlyEnrolled.length, removed };
}

async function announceEnrollment(
  client: SlackClient,
  logger: Logger,
  newlyEnrolled: string[],
  config: StandupConfigRow,
  channel: string,
): Promise<void> {
  if (newlyEnrolled.length === 0) return;

  if (newlyEnrolled.length > WELCOME_DM_LIMIT) {
    logger.info({ count: newlyEnrolled.length }, "too many new participants for individual DMs, posting in channel");
    await client.chat.postMessage({
      channel,
      text: `:wave: I'll be running daily standups here - ${newlyEnrolled.length} people enrolled. I'll DM you at ${config.default_send_time} (${config.default_timezone}) each weekday; run \`/standup-time\` to set your own schedule.`,
    });
    return;
  }

  for (const userId of newlyEnrolled) {
    await sendWelcomeDm(client, logger, userId, config);
  }
}

/**
 * Tick entry point - a full sweep at most every RECONCILE_INTERVAL_MS, except when
 * the destination channel has changed, which shouldn't wait out the throttle.
 */
export async function maybeReconcile(
  app: App,
  db: Database.Database,
  logger: Logger,
  now: Date,
): Promise<void> {
  const channel = getConfig(db)?.channel_id;
  const channelChanged = channel !== undefined && channel !== lastChannelId;
  if (!channelChanged && now.getTime() - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  await syncMembership(app, db, logger);
}

/** Single-user enrolment, used by member_joined_channel. */
export async function enrollUser(
  app: App,
  db: Database.Database,
  logger: Logger,
  userId: string,
): Promise<void> {
  const client = app.client;
  const config = getConfigOrDefault(db);
  if (!(await isHuman(client, logger, userId))) return;

  // Bolt handles events concurrently, and a join can land while a reconcile is
  // mid-sweep - the claim is what keeps that to one welcome DM.
  if (!claimJoin(db, userId, config)) return;
  logger.info({ userId }, "enrolled user in standups");
  await sendWelcomeDm(client, logger, userId, config);
}

/** Single-user removal, used by member_left_channel. Soft - settings are kept. */
export function removeUser(db: Database.Database, logger: Logger, userId: string): void {
  if (markLeft(db, userId)) logger.info({ userId }, "removed user from standups");
}
