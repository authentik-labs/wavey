import type { BotModule, ModuleContext } from "../../core/module.js";
import { migrations } from "./db.js";
import { registerCommands } from "./commands.js";
import { registerActions } from "./actions.js";
import { registerEvents } from "./events.js";
import { maybeReconcile } from "./membership.js";
import { runStandupTick } from "./scheduling.js";

/**
 * Daily standup / check-in module - a dailybot replacement.
 *
 * DMs each participant at their configured local time asking what they
 * did yesterday, what they're doing today, and any blockers; posts the
 * answers to a shared channel; nudges them with a reminder DM if they
 * haven't answered after a configurable delay.
 *
 * Participation follows membership of the destination channel - joining enrols
 * you, leaving removes you, and nobody has to run an admin command.
 */
export const standupModule: BotModule = {
  name: "standup",
  migrations,
  register(ctx: ModuleContext) {
    registerCommands(ctx.app, ctx.db);
    registerActions(ctx.app, ctx.db, ctx.logger);
    registerEvents(ctx.app, ctx.db, ctx.logger);
    ctx.scheduler.onTick("standup", (now) => runStandupTick(ctx.app, ctx.db, ctx.logger, now));
    // Separate handler so a slow membership sweep can't delay the prompt timing.
    ctx.scheduler.onTick("standup-membership", (now) => maybeReconcile(ctx.app, ctx.db, ctx.logger, now));
  },
};
