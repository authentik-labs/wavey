import type { App } from "@slack/bolt";
import { createIssueFromThread, postEphemeral, type CreateDeps } from "./create.js";
import { getIssuesForThread } from "./db.js";
import { parseMentionText, titleFromText } from "./parse.js";
import type { SlackClient } from "./thread.js";
import type { PromptState } from "./types.js";
import { buildCreatePromptMessage } from "./views.js";

/** First non-empty line of the thread's root message, used to prefill the modal's title. */
async function threadRootTitle(client: SlackClient, channel: string, threadTs: string): Promise<string> {
  try {
    const result = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
    return titleFromText(result.messages?.[0]?.text ?? "");
  } catch {
    return "";
  }
}

export function registerEvents(app: App, deps: CreateDeps, defaultRepo: string | undefined): void {
  const { db, logger } = deps;

  app.event("app_mention", async ({ event, client }) => {
    // Never react to our own posts, or to another app quoting us.
    if (event.bot_id || !event.user) return;

    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const parsed = parseMentionText(event.text ?? "");
    const repo = parsed.repo ?? defaultRepo;

    if (!repo) {
      await postEphemeral(
        client,
        channel,
        event.user,
        "No repository to file this in. Mention me as `@bot owner/repo Some title`, or set `GITHUB_DEFAULT_REPO`.",
        threadTs,
      );
      return;
    }

    try {
      if (parsed.title) {
        await createIssueFromThread(client, deps, {
          channel,
            threadTs,
          userId: event.user,
          repo,
          title: parsed.title,
          labels: parsed.labels,
          assignees: parsed.assignees,
          includeThread: true,
          force: parsed.force,
        });
        return;
      }

      // No title in the mention: an app_mention carries no trigger_id, so offer a
      // button - clicking it gives us one and opens the review modal.
      const state: PromptState = {
        channel,
        threadTs,
        repo,
        title: await threadRootTitle(client, channel, threadTs),
        labels: parsed.labels,
        assignees: parsed.assignees,
      };
      await client.chat.postEphemeral({
        channel,
        user: event.user,
        thread_ts: threadTs,
        ...buildCreatePromptMessage(state, getIssuesForThread(db, channel, threadTs)),
      });
    } catch (err) {
      logger.error({ err, channel, threadTs }, "app_mention handler failed");
      await postEphemeral(
        client,
        channel,
        event.user,
        "Something went wrong handling that mention - check the bot logs.",
        threadTs,
      ).catch(() => undefined);
    }
  });
}
