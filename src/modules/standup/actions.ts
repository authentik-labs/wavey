import type { App } from "@slack/bolt";
import type Database from "better-sqlite3";
import type { Logger } from "../../core/logger.js";
import { getConfigOrDefault, getEntryById, submitEntry, upsertConfig, upsertUser } from "./db.js";
import { syncMembership } from "./membership.js";
import {
  ACTION_FILL_OUT,
  VIEW_CONFIG,
  VIEW_SUBMIT,
  VIEW_TIME,
  buildAlreadySubmittedMessage,
  buildFillOutModal,
  buildPostedMessage,
} from "./views.js";
import { validateHHmm, validateTimezone } from "./commands.js";

type SlackClient = App["client"];

/**
 * We can only read a channel's members from inside it. Public channels we can join
 * ourselves; private ones have to invite us. Returns whether we're in.
 */
async function ensureInChannel(client: SlackClient, logger: Logger, channel: string): Promise<boolean> {
  try {
    await client.conversations.join({ channel });
    return true;
  } catch (err) {
    const code = (err as { data?: { error?: string } }).data?.error;
    if (code === "already_in_channel") return true;
    if (code === "method_not_supported_for_channel_type") {
      // Private channel - conversations.join doesn't apply, so probe membership.
      try {
        await client.conversations.members({ channel, limit: 1 });
        return true;
      } catch {
        return false;
      }
    }
    logger.warn({ err, channel }, "could not join standup channel");
    return false;
  }
}

type StateValues = Record<string, Record<string, { value?: string | null; selected_option?: { value: string } }>>;

function textValue(values: StateValues, blockId: string): string {
  return values[blockId]?.value?.value?.trim() ?? "";
}

function selectValue(values: StateValues, blockId: string): string | undefined {
  return values[blockId]?.value?.selected_option?.value;
}

export function registerActions(app: App, db: Database.Database, logger: Logger): void {
  app.action(ACTION_FILL_OUT, async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions" || !("trigger_id" in body)) return;
    const action = body.actions[0];
    if (!action || action.type !== "button") return;
    const entryId = Number(action.value);
    const entry = getEntryById(db, entryId);
    if (!entry) return;

    if (entry.status === "submitted") {
      await client.chat.postEphemeral({
        channel: entry.dm_channel_id,
        user: entry.user_id,
        ...buildAlreadySubmittedMessage(),
      });
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildFillOutModal(entry.id, {
        yesterday: entry.yesterday ?? undefined,
        today: entry.today ?? undefined,
        blockers: entry.blockers ?? undefined,
      }),
    });
  });

  app.view(VIEW_SUBMIT, async ({ ack, view, client }) => {
    const entryId = Number(view.private_metadata);
    const entry = getEntryById(db, entryId);
    if (!entry) {
      await ack();
      return;
    }

    const values = view.state.values as unknown as StateValues;
    const yesterday = textValue(values, "yesterday");
    const today = textValue(values, "today");
    const blockers = textValue(values, "blockers") || null;

    if (!yesterday || !today) {
      await ack({
        response_action: "errors",
        errors: {
          ...(yesterday ? {} : { yesterday: "This field is required." }),
          ...(today ? {} : { today: "This field is required." }),
        },
      });
      return;
    }

    await ack();

    const config = getConfigOrDefault(db);
    let postedTs: string | undefined;
    if (config.channel_id) {
      const posted = await client.chat.postMessage({
        channel: config.channel_id,
        ...buildPostedMessage(entry.user_id, { yesterday, today, blockers }),
      });
      postedTs = posted.ts;
    } else {
      logger.warn("standup submitted but no destination channel is configured yet (run /standup-setup)");
    }
    submitEntry(db, entry.id, { yesterday, today, blockers }, postedTs);

    await client.chat.postMessage({
      channel: entry.dm_channel_id,
      text: "Thanks, your standup is in! :tada:",
    });
  });

  app.view(VIEW_CONFIG, async ({ ack, view, body, client }) => {
    const values = view.state.values as unknown as StateValues;
    const rawChannel = (view.state.values as any).channel?.value?.selected_conversation as string | undefined;
    const timezone = textValue(values, "timezone");
    const sendTime = textValue(values, "send_time");
    const reminderMinutes = Number(textValue(values, "reminder_minutes"));
    const skipWeekends = selectValue(values, "skip_weekends") === "yes";

    const errors: Record<string, string> = {};
    if (!rawChannel) errors.channel = "Pick a channel.";
    if (!validateTimezone(timezone)) errors.timezone = "Not a valid IANA timezone (e.g. Europe/Vienna).";
    if (!validateHHmm(sendTime)) errors.send_time = "Use 24h HH:mm format, e.g. 09:00.";
    if (!Number.isFinite(reminderMinutes) || reminderMinutes <= 0) errors.reminder_minutes = "Enter a positive number.";

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }
    await ack();

    const channelId = rawChannel!;
    const previousChannel = getConfigOrDefault(db).channel_id;

    upsertConfig(db, {
      channel_id: channelId,
      default_timezone: timezone,
      default_send_time: sendTime,
      default_reminder_minutes: reminderMinutes,
      skip_weekends: skipWeekends ? 1 : 0,
    });

    let note = "";
    if (channelId !== previousChannel) {
      // We can only read the member list from inside the channel. Public channels we
      // can join ourselves; private ones need an invite.
      const joined = await ensureInChannel(client, logger, channelId);
      if (joined) {
        const { enrolled, removed } = await syncMembership(app, db, logger);
        note = ` Enrolled ${enrolled} participant(s)${removed ? `, removed ${removed}` : ""}.`;
      } else {
        note = ` I'm not in <#${channelId}> yet - run \`/invite @standup-bot\` there so I can see who to enroll.`;
      }
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Standup settings saved. Posting to <#${channelId}> at ${sendTime} (${timezone}) on weekdays${skipWeekends ? "" : " and weekends"}.${note}`,
    });
  });

  app.view(VIEW_TIME, async ({ ack, view, body, client }) => {
    const values = view.state.values as unknown as StateValues;
    const timezone = textValue(values, "timezone");
    const sendTime = textValue(values, "send_time");
    const reminderMinutes = Number(textValue(values, "reminder_minutes"));

    const errors: Record<string, string> = {};
    if (!validateTimezone(timezone)) errors.timezone = "Not a valid IANA timezone (e.g. America/New_York).";
    if (!validateHHmm(sendTime)) errors.send_time = "Use 24h HH:mm format, e.g. 09:00.";
    if (!Number.isFinite(reminderMinutes) || reminderMinutes <= 0) errors.reminder_minutes = "Enter a positive number.";

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }
    await ack();

    const config = getConfigOrDefault(db);
    upsertUser(db, body.user.id, { timezone, send_time: sendTime, reminder_minutes: reminderMinutes }, config);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Got it - I'll prompt you at ${sendTime} (${timezone}), with a reminder after ${reminderMinutes}m if needed.`,
    });
  });
}
