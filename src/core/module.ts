import type { App } from "@slack/bolt";
import type Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Migration } from "./db.js";
import type { Scheduler } from "./scheduler.js";

export interface ModuleContext {
  app: App;
  db: Database.Database;
  logger: Logger;
  scheduler: Scheduler;
  config: AppConfig;
}

/**
 * Contract every bot feature implements. Adding a new capability to the bot
 * means writing one of these and listing it in src/modules/index.ts -
 * nothing in core needs to change.
 */
export interface BotModule {
  name: string;
  /** Run once at startup, before register(), in array order. */
  migrations?: Migration[];
  /** Wire up slash commands, actions, views, events, and scheduler.onTick handlers. */
  register(ctx: ModuleContext): void | Promise<void>;
}
