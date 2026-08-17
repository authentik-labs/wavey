export type EntryStatus = "prompted" | "reminded" | "submitted";

/**
 * Where a user's timezone came from, in increasing order of authority. Only 'default'
 * rows may be overwritten by their Slack profile - the rest were chosen, not inherited.
 */
export type TimezoneSource = "default" | "slack" | "user";

export interface StandupConfigRow {
  id: 1;
  channel_id: string | null;
  default_timezone: string;
  default_send_time: string; // HH:mm, 24h
  default_reminder_minutes: number;
  skip_weekends: number; // sqlite boolean (0/1)
  updated_at: string;
}

export interface StandupUserRow {
  user_id: string;
  timezone: string;
  timezone_source: TimezoneSource;
  send_time: string; // HH:mm, 24h
  reminder_minutes: number;
  /** sqlite boolean (0/1) - a member of the destination channel. Owned by the membership sync. */
  in_channel: number;
  updated_at: string;
}

export interface StandupEntryRow {
  id: number;
  user_id: string;
  entry_date: string; // YYYY-MM-DD, in the user's local timezone
  status: EntryStatus;
  prompted_at: string;
  reminded_at: string | null;
  submitted_at: string | null;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  dm_channel_id: string;
  prompt_message_ts: string | null;
  posted_message_ts: string | null;
}
