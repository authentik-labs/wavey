// @slack/bolt is CommonJS. Older Node versions in our supported range (>=20) can't
// statically detect its named exports from an ESM importer, so `import { App }` throws
// at startup - only newer Node happens to get away with it. Destructuring the default
// import works everywhere.
import bolt from "@slack/bolt";
import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { openDatabase, runMigrations } from "./core/db.js";
import { Scheduler } from "./core/scheduler.js";
import type { ModuleContext } from "./core/module.js";
import { modules } from "./modules/index.js";

const { App, LogLevel } = bolt;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "unhandled rejection (likely a Slack API/socket error) - check credentials and scopes");
  });

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  const db = openDatabase(config.dbPath);
  const scheduler = new Scheduler(config.tickIntervalMs, logger);

  const ctx: ModuleContext = { app, db, logger, scheduler, config };

  for (const mod of modules) {
    if (mod.migrations?.length) {
      runMigrations(db, mod.migrations, logger.child({ module: mod.name }));
    }
  }

  for (const mod of modules) {
    await mod.register(ctx);
    logger.info({ module: mod.name }, "module registered");
  }

  await app.start();
  scheduler.start();
  logger.info("bot is running (socket mode)");

  const shutdown = async () => {
    logger.info("shutting down");
    scheduler.stop();
    await app.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
