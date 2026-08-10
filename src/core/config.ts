import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  dbPath: string;
  logLevel: string;
  tickIntervalMs: number;
}

export function loadConfig(): AppConfig {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackSigningSecret: required("SLACK_SIGNING_SECRET"),
    dbPath: process.env.DB_PATH ?? "./data/bot.sqlite3",
    logLevel: process.env.LOG_LEVEL ?? "info",
    tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 60_000),
  };
}
