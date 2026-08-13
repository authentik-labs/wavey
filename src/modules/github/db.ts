import type Database from "better-sqlite3";
import type { Migration } from "../../core/db.js";
import type { GithubIssueRow } from "./types.js";

export const migrations: Migration[] = [
  {
    name: "github.001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS github_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_url TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_github_issues_thread
        ON github_issues (channel_id, thread_ts);
    `,
  },
];

export function getIssuesForThread(
  db: Database.Database,
  channelId: string,
  threadTs: string,
): GithubIssueRow[] {
  return db
    .prepare("SELECT * FROM github_issues WHERE channel_id = ? AND thread_ts = ? ORDER BY id")
    .all(channelId, threadTs) as GithubIssueRow[];
}

export function recordIssue(
  db: Database.Database,
  row: Omit<GithubIssueRow, "id" | "created_at">,
): void {
  db.prepare(
    `INSERT INTO github_issues (channel_id, thread_ts, repo, issue_number, issue_url, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.channel_id,
    row.thread_ts,
    row.repo,
    row.issue_number,
    row.issue_url,
    row.created_by,
    new Date().toISOString(),
  );
}
