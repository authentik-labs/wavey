import type { App } from "@slack/bolt";
import type Database from "better-sqlite3";
import type { Logger } from "../../core/logger.js";
import { getConfig } from "./db.js";
import { botUserId, enrollUser, removeUser, syncMembership } from "./membership.js";

/**
 * Keeps the participant list in step with the destination channel as people come
 * and go. The tick's periodic sweep is the safety net for anything that happens
 * while the bot is down; these events are what make it feel instant.
 */
export function registerEvents(app: App, db: Database.Database, logger: Logger): void {
  app.event("member_joined_channel", async ({ event, client }) => {
    if (event.channel !== getConfig(db)?.channel_id) return;

    if (event.user === (await botUserId(client))) {
      // We've only just been added, so this is the first moment the member list is
      // readable - enrol everyone who was already here.
      logger.info({ channel: event.channel }, "added to the standup channel, reconciling membership");
      await syncMembership(app, db, logger);
      return;
    }

    await enrollUser(app, db, logger, event.user);
  });

  app.event("member_left_channel", async ({ event, client }) => {
    if (event.channel !== getConfig(db)?.channel_id) return;

    if (event.user === (await botUserId(client))) {
      // Removing the bot is usually a mistake, and standup_users is the only record
      // of everyone's schedules - warn instead of wiping the roster.
      logger.warn(
        { channel: event.channel },
        "removed from the standup channel - prompts will stop until I'm invited back",
      );
      return;
    }

    removeUser(db, logger, event.user);
  });
}
