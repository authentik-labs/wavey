import type { BotModule, ModuleContext } from "../../core/module.js";
import { migrations } from "./db.js";
import { registerCommands } from "./commands.js";
import { registerActions } from "./actions.js";
import { runStandupTick } from "./scheduling.js";

/**
 * Daily standup / check-in module - a dailybot replacement.
 *
 * DMs each opted-in user at their configured local time asking what they
 * did yesterday, what they're doing today, and any blockers; posts the
 * answers to a shared channel; nudges them with a reminder DM if they
 * haven't answered after a configurable delay.
 */
export const standupModule: BotModule = {
  name: "standup",
  migrations,
  register(ctx: ModuleContext) {
    registerCommands(ctx.app, ctx.db);
    registerActions(ctx.app, ctx.db, ctx.logger);
    ctx.scheduler.onTick("standup", (now) => runStandupTick(ctx.app, ctx.db, ctx.logger, now));
  },
};
