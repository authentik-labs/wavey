import type { KnownBlock, View } from "@slack/bolt";
import type { StandupConfigRow, StandupUserRow } from "./types.js";

export const ACTION_FILL_OUT = "standup_fill_out";
export const VIEW_SUBMIT = "standup_submit_modal";
export const VIEW_CONFIG = "standup_config_modal";
export const VIEW_TIME = "standup_time_modal";

export function buildPromptMessage(entryId: number): { text: string; blocks: KnownBlock[] } {
  return {
    text: "Time for your daily standup! What did you work on yesterday, and what's today's plan?",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":wave: Time for your daily standup! What did you work on yesterday, and what's today's plan?",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_FILL_OUT,
            style: "primary",
            text: { type: "plain_text", text: "Fill out standup" },
            value: String(entryId),
          },
        ],
      },
    ],
  };
}

export function buildReminderMessage(entryId: number): { text: string; blocks: KnownBlock[] } {
  return {
    text: "Friendly reminder: you haven't filled out today's standup yet.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":alarm_clock: Friendly reminder — you haven't filled out today's standup yet.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_FILL_OUT,
            style: "primary",
            text: { type: "plain_text", text: "Fill out standup" },
            value: String(entryId),
          },
        ],
      },
    ],
  };
}

export function buildAlreadySubmittedMessage(): { text: string; blocks: KnownBlock[] } {
  return {
    text: "Thanks, already got your standup for today! :white_check_mark:",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":white_check_mark: Thanks, already got your standup for today!" },
      },
    ],
  };
}

export function buildFillOutModal(entryId: number, prefill?: { yesterday?: string; today?: string; blockers?: string }): View {
  return {
    type: "modal",
    callback_id: VIEW_SUBMIT,
    private_metadata: String(entryId),
    title: { type: "plain_text", text: "Daily standup" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "yesterday",
        label: { type: "plain_text", text: "What did you work on yesterday?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: prefill?.yesterday,
        },
      },
      {
        type: "input",
        block_id: "today",
        label: { type: "plain_text", text: "What are you working on today?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: prefill?.today,
        },
      },
      {
        type: "input",
        block_id: "blockers",
        optional: true,
        label: { type: "plain_text", text: "Any blockers? (optional)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: prefill?.blockers,
        },
      },
    ],
  };
}

export function buildPostedMessage(
  userId: string,
  fields: { yesterday: string; today: string; blockers: string | null },
): { text: string; blocks: KnownBlock[] } {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<@${userId}>'s standup*` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Yesterday:*\n${fields.yesterday}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Today:*\n${fields.today}` },
    },
  ];
  if (fields.blockers) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Blockers:*\n${fields.blockers}` },
    });
  }
  return { text: `${userId}'s standup update`, blocks };
}

export function buildConfigModal(current: StandupConfigRow): View {
  return {
    type: "modal",
    callback_id: VIEW_CONFIG,
    title: { type: "plain_text", text: "Standup setup" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "channel",
        label: { type: "plain_text", text: "Post standups to" },
        element: {
          type: "conversations_select",
          action_id: "value",
          default_to_current_conversation: false,
          filter: { include: ["public", "private"] },
          ...(current.channel_id ? { initial_conversation: current.channel_id } : {}),
        },
      },
      {
        type: "input",
        block_id: "timezone",
        label: { type: "plain_text", text: "Default timezone (IANA, e.g. Europe/Vienna)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: current.default_timezone,
        },
      },
      {
        type: "input",
        block_id: "send_time",
        label: { type: "plain_text", text: "Default send time (24h HH:mm)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: current.default_send_time,
        },
      },
      {
        type: "input",
        block_id: "reminder_minutes",
        label: { type: "plain_text", text: "Default reminder delay (minutes)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: String(current.default_reminder_minutes),
        },
      },
      {
        type: "input",
        block_id: "skip_weekends",
        label: { type: "plain_text", text: "Skip weekends" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option:
            current.skip_weekends === 1
              ? { text: { type: "plain_text", text: "Yes" }, value: "yes" }
              : { text: { type: "plain_text", text: "No" }, value: "no" },
          options: [
            { text: { type: "plain_text", text: "Yes" }, value: "yes" },
            { text: { type: "plain_text", text: "No" }, value: "no" },
          ],
        },
      },
    ],
  };
}

export function buildTimeModal(current: StandupUserRow): View {
  return {
    type: "modal",
    callback_id: VIEW_TIME,
    title: { type: "plain_text", text: "My standup settings" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "timezone",
        label: { type: "plain_text", text: "Your timezone (IANA, e.g. America/New_York)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: current.timezone,
        },
      },
      {
        type: "input",
        block_id: "send_time",
        label: { type: "plain_text", text: "Send prompt at (24h HH:mm, your local time)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: current.send_time,
        },
      },
      {
        type: "input",
        block_id: "reminder_minutes",
        label: { type: "plain_text", text: "Remind me after (minutes) if I haven't submitted" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: String(current.reminder_minutes),
        },
      },
    ],
  };
}
