import type { App } from "@slack/bolt";
import type Database from "better-sqlite3";
import type { Logger } from "../../core/logger.js";
import {
  getConfigOrDefault,
  getEntryById,
  getUser,
  submitEntry,
  upsertConfig,
  upsertUser,
} from "./db.js";
import {
  ACTION_FILL_OUT,
  VIEW_CONFIG,
  VIEW_INVITE,
  VIEW_SUBMIT,
  VIEW_TIME,
  buildAlreadySubmittedMessage,
  buildFillOutModal,
  buildPostedMessage,
} from "./views.js";
import { validateHHmm, validateTimezone } from "./commands.js";

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

    upsertConfig(db, {
      channel_id: rawChannel!,
      default_timezone: timezone,
      default_send_time: sendTime,
      default_reminder_minutes: reminderMinutes,
      skip_weekends: skipWeekends ? 1 : 0,
    });

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Standup settings saved. Posting to <#${rawChannel}> at ${sendTime} (${timezone}) on weekdays${skipWeekends ? "" : " and weekends"}.`,
    });
  });

  app.view(VIEW_TIME, async ({ ack, view, body, client }) => {
    const values = view.state.values as unknown as StateValues;
    const timezone = textValue(values, "timezone");
    const sendTime = textValue(values, "send_time");
    const reminderMinutes = Number(textValue(values, "reminder_minutes"));
    const enabled = selectValue(values, "enabled") === "yes";

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
    upsertUser(
      db,
      body.user.id,
      { timezone, send_time: sendTime, reminder_minutes: reminderMinutes, enabled: enabled ? 1 : 0 },
      config,
    );

    await client.chat.postMessage({
      channel: body.user.id,
      text: enabled
        ? `Got it - I'll prompt you at ${sendTime} (${timezone}), with a reminder after ${reminderMinutes}m if needed.`
        : "Got it - you're opted out of daily standups. Run /standup-time again anytime to opt back in.",
    });
  });

  app.view(VIEW_INVITE, async ({ ack, view, body, client }) => {
    await ack();
    const channelId = (view.state.values as any).channel?.value?.selected_conversation as string | undefined;
    if (!channelId) return;

    const config = getConfigOrDefault(db);
    const botUserId = (await client.auth.test()).user_id;

    const memberIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
      memberIds.push(...(page.members ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    let enrolled = 0;
    for (const userId of memberIds) {
      if (userId === botUserId || getUser(db, userId)) continue; // skip the bot itself and anyone already configured
      const info = await client.users.info({ user: userId });
      const u = info.user;
      if (!u || u.is_bot || u.deleted) continue;

      upsertUser(db, userId, {}, config);
      enrolled++;
      try {
        const dm = await client.conversations.open({ users: userId });
        await client.chat.postMessage({
          channel: dm.channel!.id!,
          text: `You've been enrolled in daily standups :wave: I'll DM you at ${config.default_send_time} (${config.default_timezone}) each weekday. Run /standup-time anytime to change your schedule or opt out.`,
        });
      } catch (err) {
        logger.warn({ err, userId }, "failed to send standup welcome DM");
      }
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Enrolled ${enrolled} new participant(s) from <#${channelId}>.`,
    });
  });
}
