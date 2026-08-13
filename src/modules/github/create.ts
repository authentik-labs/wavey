import type Database from "better-sqlite3";
import type { Logger } from "../../core/logger.js";
import { getIssuesForThread, recordIssue } from "./db.js";
import type { ClientProvider } from "./auth.js";
import { createIssue, describeGitHubError } from "./github.js";
import { REPO_RE } from "./parse.js";
import { fetchThread, renderIssueBody, resolveUserName, type SlackClient } from "./thread.js";
import { buildCreatedMessage, buildDuplicateMessage } from "./views.js";

export interface CreateDeps {
  db: Database.Database;
  logger: Logger;
  github: ClientProvider;
}

export interface CreateRequest {
  channel: string;
  threadTs: string;
  /** Slack user who asked for the issue. */
  userId: string;
  repo: string;
  title: string;
  labels: string[];
  assignees: string[];
  additionalContext?: string;
  includeThread: boolean;
  force: boolean;
}

export async function postEphemeral(
  client: SlackClient,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  await client.chat.postEphemeral({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
}

async function channelName(client: SlackClient, channel: string): Promise<string | undefined> {
  try {
    const info = await client.conversations.info({ channel });
    return info.channel?.name;
  } catch {
    return undefined;
  }
}

async function permalink(client: SlackClient, channel: string, ts: string): Promise<string | undefined> {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    return result.permalink;
  } catch {
    // A missing permalink is not worth failing the issue over.
    return undefined;
  }
}

/**
 * Shared by the instant path (an @-mention that already carries a title) and the
 * modal path. Reports every failure back to the requester as an ephemeral message.
 */
export async function createIssueFromThread(
  client: SlackClient,
  deps: CreateDeps,
  request: CreateRequest,
): Promise<void> {
  const { db, logger, github } = deps;
  const { channel, threadTs, userId, repo, title } = request;

  if (!REPO_RE.test(repo)) {
    await postEphemeral(
      client,
      channel,
      userId,
      `\`${repo}\` doesn't look like a repository. Use \`owner/repo\`.`,
      threadTs,
    );
    return;
  }

  if (!request.force) {
    const existing = getIssuesForThread(db, channel, threadTs);
    if (existing.length > 0) {
      await postEphemeral(client, channel, userId, buildDuplicateMessage(existing), threadTs);
      return;
    }
  }

  const reporterName = await resolveUserName(client, new Map(), userId);
  const [name, link, messages] = await Promise.all([
    channelName(client, channel),
    permalink(client, channel, threadTs),
    request.includeThread ? fetchThread(client, channel, threadTs) : Promise.resolve([]),
  ]);

  const body = renderIssueBody({
    reporterName,
    channelName: name,
    permalink: link,
    additionalContext: request.additionalContext,
    messages,
  });

  let created;
  try {
    const octokit = await github.octokitForRepo(repo);
    created = await createIssue(octokit, {
      repo,
      title,
      body,
      labels: request.labels,
      assignees: request.assignees,
    });
  } catch (err) {
    logger.error({ err, repo, channel, threadTs }, "failed to create github issue");
    await postEphemeral(client, channel, userId, describeGitHubError(err, repo), threadTs);
    return;
  }

  recordIssue(db, {
    channel_id: channel,
    thread_ts: threadTs,
    repo,
    issue_number: created.number,
    issue_url: created.htmlUrl,
    created_by: userId,
  });

  logger.info({ repo, issue: created.number, channel, userId }, "created github issue from slack thread");

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    ...buildCreatedMessage(repo, created.number, created.htmlUrl, userId),
  });
}
