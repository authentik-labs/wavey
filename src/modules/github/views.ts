import type { KnownBlock, View } from "@slack/types";
import type { GithubIssueRow, PromptState } from "./types.js";

export const ACTION_OPEN_MODAL = "github_open_modal";
export const VIEW_CREATE_ISSUE = "github_create_issue_modal";

/** Value of the "include full thread transcript" checkbox. */
export const INCLUDE_THREAD_VALUE = "include_thread";

export interface ModalMetadata {
  channel: string;
  threadTs: string;
}

/**
 * Posted (ephemerally, in-thread) when someone mentions the bot without a title.
 * The button carries the state the modal needs, because an app_mention event has
 * no trigger_id of its own.
 */
export function buildCreatePromptMessage(
  state: PromptState,
  existing: GithubIssueRow[] = [],
): { text: string; blocks: KnownBlock[] } {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:memo: Create a GitHub issue from this thread in \`${state.repo}\`?`,
      },
    },
  ];

  if (existing.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:warning: This thread already has ${existing
            .map((row) => `<${row.issue_url}|${row.repo}#${row.issue_number}>`)
            .join(", ")}.`,
        },
      ],
    });
  }

  return {
    text: "Create a GitHub issue from this thread?",
    blocks: [
      ...blocks,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_OPEN_MODAL,
            style: "primary",
            text: { type: "plain_text", text: "Create GitHub issue" },
            value: JSON.stringify(state),
          },
        ],
      },
    ],
  };
}

export function buildIssueModal(state: PromptState): View {
  const metadata: ModalMetadata = { channel: state.channel, threadTs: state.threadTs };
  return {
    type: "modal",
    callback_id: VIEW_CREATE_ISSUE,
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "New GitHub issue" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "repo",
        label: { type: "plain_text", text: "Repository (owner/repo)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(state.repo ? { initial_value: state.repo } : {}),
          placeholder: { type: "plain_text", text: "goauthentik/authentik" },
        },
      },
      {
        type: "input",
        block_id: "title",
        label: { type: "plain_text", text: "Title" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(state.title ? { initial_value: state.title } : {}),
        },
      },
      {
        type: "input",
        block_id: "context",
        optional: true,
        label: { type: "plain_text", text: "Additional context (optional)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: { type: "plain_text", text: "Anything that isn't already in the thread" },
        },
      },
      {
        type: "input",
        block_id: "labels",
        optional: true,
        label: { type: "plain_text", text: "Labels (comma-separated, optional)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(state.labels.length ? { initial_value: state.labels.join(", ") } : {}),
        },
      },
      {
        type: "input",
        block_id: "assignees",
        optional: true,
        label: { type: "plain_text", text: "Assignees (GitHub usernames, comma-separated, optional)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(state.assignees.length ? { initial_value: state.assignees.join(", ") } : {}),
        },
      },
      {
        type: "input",
        block_id: "include_thread",
        optional: true,
        label: { type: "plain_text", text: "Thread transcript" },
        element: {
          type: "checkboxes",
          action_id: "value",
          initial_options: [
            {
              text: { type: "plain_text", text: "Include the full thread in the issue body" },
              value: INCLUDE_THREAD_VALUE,
            },
          ],
          options: [
            {
              text: { type: "plain_text", text: "Include the full thread in the issue body" },
              value: INCLUDE_THREAD_VALUE,
            },
          ],
        },
      },
    ],
  };
}

export function buildCreatedMessage(
  repo: string,
  issueNumber: number,
  issueUrl: string,
  creatorId: string,
): { text: string; blocks: KnownBlock[] } {
  const text = `Created <${issueUrl}|${repo}#${issueNumber}> for <@${creatorId}>`;
  return {
    text: `Created ${repo}#${issueNumber}: ${issueUrl}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `:white_check_mark: ${text}` } }],
  };
}

export function buildDuplicateMessage(rows: GithubIssueRow[]): string {
  const existing = rows.map((row) => `<${row.issue_url}|${row.repo}#${row.issue_number}>`).join(", ");
  return `This thread already has ${rows.length === 1 ? "an issue" : "issues"}: ${existing}. Mention me again with \`--force\` to create another.`;
}
