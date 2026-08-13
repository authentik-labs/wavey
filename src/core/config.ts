import { readFileSync } from "node:fs";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * A PEM private key is awkward to carry in an env var, so accept whichever form is
 * convenient: a path to the .pem, the PEM inline (with real or `\n`-escaped
 * newlines), or the PEM base64-encoded.
 */
function loadPrivateKey(): string | undefined {
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`Could not read GITHUB_APP_PRIVATE_KEY_PATH (${path}): ${(err as Error).message}`);
    }
  }

  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!inline) return undefined;
  const unescaped = inline.replace(/\\n/g, "\n");
  if (unescaped.includes("-----BEGIN")) return unescaped;

  const decoded = Buffer.from(inline, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  throw new Error("GITHUB_APP_PRIVATE_KEY is neither a PEM key nor base64-encoded PEM");
}

export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  dbPath: string;
  logLevel: string;
  tickIntervalMs: number;
  /** Optional - only the github module needs these; the bot boots fine without them. */
  githubAppId?: string;
  githubAppPrivateKey?: string;
  /** Pins the module to one installation; otherwise it's looked up per repo. */
  githubAppInstallationId?: number;
  githubDefaultRepo?: string;
  githubApiBaseUrl: string;
}

export function loadConfig(): AppConfig {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackSigningSecret: required("SLACK_SIGNING_SECRET"),
    dbPath: process.env.DB_PATH ?? "./data/bot.sqlite3",
    logLevel: process.env.LOG_LEVEL ?? "info",
    tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 60_000),
    githubAppId: process.env.GITHUB_APP_ID || undefined,
    githubAppPrivateKey: loadPrivateKey(),
    githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID
      ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
      : undefined,
    githubDefaultRepo: process.env.GITHUB_DEFAULT_REPO || undefined,
    githubApiBaseUrl: (process.env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}
