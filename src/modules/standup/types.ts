export type EntryStatus = "prompted" | "reminded" | "submitted";

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
  send_time: string; // HH:mm, 24h
  reminder_minutes: number;
  enabled: number; // sqlite boolean (0/1)
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
