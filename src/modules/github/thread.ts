import type { App } from "@slack/bolt";
import type { ThreadMessage } from "./types.js";

export type SlackClient = App["client"];

/** GitHub caps issue bodies at 65536 characters; leave headroom for the header. */
const MAX_BODY_CHARS = 60_000;

const USER_MENTION_RE = /<@([UWB][A-Z0-9]+)(?:\|([^>]*))?>/g;
const CHANNEL_MENTION_RE = /<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g;
const SPECIAL_MENTION_RE = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const LINK_RE = /<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/g;
const SUBTEAM_RE = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g;
/** Slack's single-asterisk bold, only when it clearly wraps a word - avoids mangling stray asterisks. */
const SLACK_BOLD_RE = /(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g;

/**
 * Converts Slack's mrkdwn into GitHub-flavoured markdown. Entity unescaping happens
 * last so that `&amp;` inside a URL survives link extraction.
 */
export function slackToMarkdown(text: string, names: Map<string, string>): string {
  return text
    .replace(LINK_RE, (_m, url: string, label?: string) => (label ? `[${label}](${url})` : url))
    .replace(USER_MENTION_RE, (_m, id: string, label?: string) => `@${label || names.get(id) || id}`)
    .replace(CHANNEL_MENTION_RE, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(SUBTEAM_RE, (_m, label?: string) => `@${label || "group"}`)
    .replace(SPECIAL_MENTION_RE, (_m, keyword: string) => `@${keyword}`)
    .replace(SLACK_BOLD_RE, (_m, lead: string, inner: string) => `${lead}**${inner}**`)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "1723300000.000100" -> "2024-08-10 14:26 UTC" */
export function formatSlackTs(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) return ts;
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Resolves a Slack user ID to a display name, caching within one thread render. */
export async function resolveUserName(
  client: SlackClient,
  cache: Map<string, string>,
  userId: string,
): Promise<string> {
  const cached = cache.get(userId);
  if (cached) return cached;
  let name = userId;
  try {
    const info = await client.users.info({ user: userId });
    const user = info.user;
    name = user?.profile?.display_name || user?.real_name || user?.name || userId;
  } catch {
    // A deactivated or invisible user shouldn't sink the whole issue - fall back to the raw ID.
  }
  cache.set(userId, name);
  return name;
}

/**
 * Fetches every message in a thread (or the single message, when it isn't threaded)
 * and renders each one's text as markdown with user IDs resolved to names.
 */
export async function fetchThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const raw: { user?: string; username?: string; botName?: string; ts: string; text: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({ channel, ts: threadTs, cursor, limit: 200 });
    for (const message of page.messages ?? []) {
      if (!message.ts) continue;
      raw.push({
        user: message.user,
        // `username` is set on messages posted by apps via chat.postMessage but is
        // missing from the SDK's MessageElement type.
        username: (message as { username?: string }).username,
        botName: message.bot_profile?.name,
        ts: message.ts,
        text: message.text ?? "",
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const names = new Map<string, string>();
  const mentioned = new Set<string>();
  for (const message of raw) {
    if (message.user) mentioned.add(message.user);
    for (const match of message.text.matchAll(USER_MENTION_RE)) {
      if (match[1]) mentioned.add(match[1]);
    }
  }
  for (const userId of mentioned) {
    await resolveUserName(client, names, userId);
  }

  return raw.map((message) => ({
    authorName: message.user
      ? (names.get(message.user) ?? message.user)
      : (message.username ?? message.botName ?? "bot"),
    ts: message.ts,
    text: slackToMarkdown(message.text, names),
  }));
}

export interface IssueBodyOptions {
  reporterName: string;
  channelName?: string;
  permalink?: string;
  additionalContext?: string;
  messages: ThreadMessage[];
}

export function renderIssueBody(options: IssueBodyOptions): string {
  const { reporterName, channelName, permalink, additionalContext, messages } = options;

  const where = channelName ? ` in #${channelName}` : "";
  const link = permalink ? ` — [view thread](${permalink})` : "";
  const parts = [`Reported from Slack by @${reporterName}${where}${link}`];

  if (additionalContext?.trim()) parts.push(additionalContext.trim());

  if (messages.length) {
    const transcript = messages
      .map((message) => `**${message.authorName}** — ${formatSlackTs(message.ts)}\n\n${message.text || "_(no text)_"}`)
      .join("\n\n");
    parts.push("---", transcript);
  }

  const body = parts.join("\n\n");
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n_…transcript truncated; see the Slack thread for the rest._`;
}
