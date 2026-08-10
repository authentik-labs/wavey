# slackbot

A modular Slack bot built on [Bolt for JS](https://slack.dev/bolt-js/) + Socket Mode. Ships
with a **standup** module - a dailybot replacement that DMs each person at a
configurable time in their own timezone, collects "yesterday / today /
blockers", posts the answers to a shared channel, and sends a follow-up
reminder if they haven't responded.

## How it's organized

```
src/
  core/            # framework: nothing standup-specific lives here
    config.ts      # env var loading
    db.ts          # sqlite connection + migration runner
    logger.ts       # pino logger
    module.ts       # the BotModule contract every feature implements
    scheduler.ts     # shared tick loop (checked once a minute by default)
  modules/
    index.ts        # the list of installed modules - add new features here
    standup/         # the standup/check-in feature, self-contained
  index.ts           # wires config + db + scheduler + modules together, starts the app
```

### Adding a new module

Everything about a feature - its DB tables, Slack commands/views/actions, and
any scheduled behavior - lives under `src/modules/<name>/` and exports one
object satisfying `BotModule` (`src/core/module.ts`):

```ts
export const myModule: BotModule = {
  name: "my-module",
  migrations: [{ name: "my-module.001_init", sql: "CREATE TABLE ..." }],
  register(ctx) {
    ctx.app.command("/my-command", async ({ ack }) => { await ack(); /* ... */ });
    ctx.scheduler.onTick("my-module", (now) => { /* runs every tick */ });
  },
};
```

Then add it to the array in `src/modules/index.ts`. Core code never needs to
change - migrations run automatically at startup, and the scheduler tick is
shared infrastructure.

## Setting up the Slack app

1. Go to <https://api.slack.com/apps> -> **Create New App** -> **From an app manifest**.
2. Pick your workspace, paste in the contents of [`app-manifest.yml`](./app-manifest.yml), and create the app.
3. Under **Basic Information**, copy the **Signing Secret** -> `SLACK_SIGNING_SECRET`.
4. Under **Basic Information -> App-Level Tokens**, create a token with the `connections:write` scope -> `SLACK_APP_TOKEN` (starts with `xapp-`).
5. Under **OAuth & Permissions**, install the app to your workspace and copy the **Bot User OAuth Token** -> `SLACK_BOT_TOKEN` (starts with `xoxb-`).
6. Invite the bot to whichever channel you want standups posted to (e.g. `/invite @standup-bot` in `#standup`).

## Running it

```bash
cp .env.example .env   # fill in the three SLACK_* tokens from above
npm install
npm run dev             # ts watch mode, for local development
# or
npm run build && npm start
```

The SQLite database is created at `DB_PATH` (default `./data/bot.sqlite3`) on first run.

## Using the standup module

- `/standup-setup` (workspace admins) - pick the destination channel, default timezone, default send time, default reminder delay, and whether to skip weekends.
- `/standup-invite` (workspace admins) - enroll everyone in a given channel using the defaults from `/standup-setup`; existing participants' settings are left untouched.
- `/standup-time` (anyone) - set your own timezone / send time / reminder delay, or opt in/out entirely.
- `/standup-now` (anyone) - fill out today's standup immediately, without waiting for your scheduled prompt.

Each enabled user gets DM'd at their configured local time with a "Fill out
standup" button that opens a short form (yesterday / today / blockers, the
last one optional). Submitting posts a formatted summary to the configured
channel. If they haven't submitted after their configured reminder delay
(default 2 hours), they get one follow-up DM.

### Notes / current limitations

- Single-workspace deployment (one bot token, one Socket Mode connection). Multi-workspace/OAuth installs aren't implemented.
- Reminders are sent at most once per day per person - no repeated nagging.
- Weekday/weekend skipping is global (`skip_weekends` in `/standup-setup`), not per-user.
