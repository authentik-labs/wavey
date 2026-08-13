import { IANAZone } from "luxon";
import type { App, SlackCommandMiddlewareArgs, AllMiddlewareArgs } from "@slack/bolt";
import type Database from "better-sqlite3";
import { getConfigOrDefault, getEntry, getPreviousSubmittedEntry, getUser, getOrCreateEntry } from "./db.js";
import { localDate } from "./scheduling.js";
import {
  buildAlreadySubmittedMessage,
  buildConfigModal,
  buildFillOutModal,
  buildTimeModal,
} from "./views.js";

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

async function isWorkspaceAdmin(app: App, userId: string): Promise<boolean> {
  const info = await app.client.users.info({ user: userId });
  return Boolean(info.user?.is_admin || info.user?.is_owner);
}

type CommandArgs = AllMiddlewareArgs & SlackCommandMiddlewareArgs;

export function registerCommands(app: App, db: Database.Database): void {
  app.command("/standup-setup", async ({ ack, command, client }: CommandArgs) => {
    await ack();
    if (!(await isWorkspaceAdmin(app, command.user_id))) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Only workspace admins can run /standup-setup.",
      });
      return;
    }
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildConfigModal(getConfigOrDefault(db)),
    });
  });

  app.command("/standup-time", async ({ ack, command, client }: CommandArgs) => {
    await ack();
    const existing = getUser(db, command.user_id);
    if (!existing || existing.in_channel !== 1) {
      // Opening the modal would create a row on submit, self-enrolling someone the
      // next membership sweep would just remove again.
      const channelId = getConfigOrDefault(db).channel_id;
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: channelId
          ? `You're not in <#${channelId}> yet - join it and I'll start including you in daily standups.`
          : "Daily standups aren't set up yet - an admin needs to run /standup-setup first.",
      });
      return;
    }
    await client.views.open({ trigger_id: command.trigger_id, view: buildTimeModal(existing) });
  });

  app.command("/standup-now", async ({ ack, command, client }: CommandArgs) => {
    await ack();
    const config = getConfigOrDefault(db);
    const user = getUser(db, command.user_id);
    const tz = user?.timezone ?? config.default_timezone;
    const today = localDate(tz, new Date());

    let entry = getEntry(db, command.user_id, today);
    if (entry?.status === "submitted") {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        ...buildAlreadySubmittedMessage(),
      });
      return;
    }

    if (!entry) {
      const dm = await client.conversations.open({ users: command.user_id });
      const dmChannelId = dm.channel?.id;
      if (!dmChannelId) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: "Couldn't open a DM with you to track this - please try again.",
        });
        return;
      }
      // getOrCreate, not create: a scheduled tick may have inserted the row while
      // we were opening the DM.
      entry = getOrCreateEntry(db, command.user_id, today, dmChannelId);
      if (entry.status === "submitted") {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          ...buildAlreadySubmittedMessage(),
        });
        return;
      }
    }

    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildFillOutModal(
        entry.id,
        {
          yesterday: entry.yesterday ?? undefined,
          today: entry.today ?? undefined,
          blockers: entry.blockers ?? undefined,
        },
        getPreviousSubmittedEntry(db, command.user_id, today),
      ),
    });
  });
}

export function validateTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function validateHHmm(value: string): boolean {
  return HHMM_RE.test(value);
}
