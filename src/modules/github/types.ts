/** Result of parsing the text of an `@bot ...` mention. */
export interface ParsedMention {
  /** `owner/repo`, if the mention named one explicitly. */
  repo?: string;
  /** Everything that wasn't a flag or the repo, joined back together. Empty means "open the modal". */
  title: string;
  labels: string[];
  assignees: string[];
  /** Create a second issue even if this thread already has one. */
  force: boolean;
}

/** One message of a Slack thread, with its text already rendered as GitHub markdown. */
export interface ThreadMessage {
  authorName: string;
  /** Slack message ts, e.g. "1723300000.000100". */
  ts: string;
  text: string;
}

export interface GithubIssueRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  created_by: string;
  created_at: string;
}

/** State carried from an @-mention through the button into the modal. */
export interface PromptState {
  channel: string;
  threadTs: string;
  repo: string;
  title: string;
  labels: string[];
  assignees: string[];
}
