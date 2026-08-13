import type { App } from "@slack/bolt";
import { createIssueFromThread, type CreateDeps } from "./create.js";
import { REPO_RE, truncateTitle } from "./parse.js";
import type { PromptState } from "./types.js";
import {
  ACTION_OPEN_MODAL,
  INCLUDE_THREAD_VALUE,
  VIEW_CREATE_ISSUE,
  buildIssueModal,
  type ModalMetadata,
} from "./views.js";

type StateValues = Record<
  string,
  Record<
    string,
    { value?: string | null; selected_options?: { value: string }[] }
  >
>;

function textValue(values: StateValues, blockId: string): string {
  return values[blockId]?.value?.value?.trim() ?? "";
}

function isChecked(values: StateValues, blockId: string, optionValue: string): boolean {
  return Boolean(values[blockId]?.value?.selected_options?.some((option) => option.value === optionValue));
}

function splitList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim().replace(/^@/, "");
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function registerActions(app: App, deps: CreateDeps): void {
  const { logger } = deps;

  app.action(ACTION_OPEN_MODAL, async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions" || !("trigger_id" in body)) return;
    const action = body.actions[0];
    if (!action || action.type !== "button" || !action.value) return;

    let state: PromptState;
    try {
      state = JSON.parse(action.value) as PromptState;
    } catch (err) {
      logger.error({ err }, "github: unparseable button state");
      return;
    }

    await client.views.open({ trigger_id: body.trigger_id, view: buildIssueModal(state) });
  });

  app.view(VIEW_CREATE_ISSUE, async ({ ack, view, body, client }) => {
    const values = view.state.values as unknown as StateValues;
    const repo = textValue(values, "repo");
    const title = truncateTitle(textValue(values, "title"));

    const errors: Record<string, string> = {};
    if (!REPO_RE.test(repo)) errors.repo = "Use owner/repo, e.g. goauthentik/authentik.";
    if (!title) errors.title = "Give the issue a title.";
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }
    await ack();

    let metadata: ModalMetadata;
    try {
      metadata = JSON.parse(view.private_metadata) as ModalMetadata;
    } catch (err) {
      logger.error({ err }, "github: unparseable modal metadata");
      return;
    }

    await createIssueFromThread(client, deps, {
      channel: metadata.channel,
      threadTs: metadata.threadTs,
      userId: body.user.id,
      repo,
      title,
      labels: splitList(textValue(values, "labels")),
      assignees: splitList(textValue(values, "assignees")),
      additionalContext: textValue(values, "context") || undefined,
      includeThread: isChecked(values, "include_thread", INCLUDE_THREAD_VALUE),
      // The modal is an explicit confirmation - the prompt already warned about duplicates.
      force: true,
    });
  });
}
