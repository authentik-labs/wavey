# wavey

A modular Slack bot built on [Bolt for JS](https://slack.dev/bolt-js/) + Socket Mode. Ships
with two modules:

- **standup** - a dailybot replacement that DMs each person at a configurable time in their
  own timezone, collects "yesterday / today / blockers", posts the answers to a shared
  channel, and sends a follow-up reminder if they haven't responded.
- **github** - @-mention the bot in any channel or thread to turn the conversation into a
  GitHub issue.

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
    github/          # @-mention -> GitHub issue, self-contained
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
6. Invite the bot to whichever channel you want standups posted to (e.g. `/invite @wavey` in `#standup`), and to any channel where people should be able to @-mention it for GitHub issues.

If you're upgrading an existing install, re-import `app-manifest.yml` and reinstall the app -
the github module needs the `app_mentions:read`, `channels:history`, `groups:history` and
`mpim:history` scopes plus the `app_mention` event, and the standup module needs
`chat:write.customize` to post under each person's name, none of which older installs have.

Re-importing is also what renames the bot: an app installed before this was called *Standup Bot*
and answered to `@standup-bot`. Until you re-import, `@wavey` won't resolve in your workspace and
the `/invite @wavey` instructions above (and the one the bot prints itself) will point at a handle
that doesn't exist yet.

## Running it

```bash
cp .env.example .env   # fill in the three SLACK_* tokens from above
npm install
npm run dev             # ts watch mode, for local development
# or
npm run build && npm start
```

The SQLite database is created at `DB_PATH` (default `./data/bot.sqlite3`) on first run.

## Deploying

### Docker

```bash
docker build -t wavey .
docker run -d --name wavey \
  --env-file .env \
  -v wavey-data:/data \
  -e DB_PATH=/data/bot.sqlite3 \
  wavey
```

The image is a two-stage Debian slim build running as the non-root `node` user. **Mount something at
`/data`** — that's where the SQLite file lives, and without a volume the database dies with the
container.

### Kubernetes

[`k8s/deployment.yaml`](./k8s/deployment.yaml) is a PersistentVolumeClaim plus a Deployment.
There's no Service: Socket Mode dials out to Slack, so the bot listens on nothing.

```bash
kubectl create secret generic wavey \
  --from-literal=SLACK_BOT_TOKEN=xoxb-... \
  --from-literal=SLACK_APP_TOKEN=xapp-... \
  --from-literal=SLACK_SIGNING_SECRET=... \
  --from-literal=GITHUB_APP_ID=123456 \
  --from-literal=GITHUB_DEFAULT_REPO=owner/repo

# github module only
kubectl create secret generic wavey-github-key \
  --from-file=github-app.pem=./github-app.private-key.pem

# set `image:` to your registry first
kubectl apply -f k8s/deployment.yaml
```

**Keep `replicas: 1` and `strategy: Recreate`.** The state is a SQLite file on a ReadWriteOnce
volume and each replica runs its own scheduler, so a second pod means two tick loops racing over
one database — and a RollingUpdate briefly creates exactly that. The bot takes no inbound traffic,
so the few seconds of downtime cost nothing and a missed tick is picked up by the next one.

## Using the standup module

- `/standup-setup` (workspace admins) - pick the destination channel, default timezone, default send time, default reminder delay, and whether to skip weekends.
- `/standup-time` (participants) - set your own timezone / send time / reminder delay.
- `/standup-now` (anyone) - fill out today's standup immediately, without waiting for your scheduled prompt.

**Membership of the destination channel is the participant list.** Joining it enrols you (with a
welcome DM); leaving removes you. There's no invite command and no admin step — the bot reacts to
join/leave events and re-checks the full member list every 15 minutes, so it self-heals after
downtime. Leaving the channel is also how you opt out.

Removal is soft: your timezone and send time are kept, so rejoining restores your settings rather
than resetting them to the defaults.

The bot has to be in the destination channel to read its members. `/standup-setup` joins public
channels automatically; for a private one, `/invite @wavey` there and it'll pick everyone up.

Each participant gets DM'd at their configured local time with a "Fill out
standup" button that opens a short form (yesterday / today / blockers, the
last one optional). The form shows your last standup — what you planned and any
blockers, with the date it was from — above the fields for reference; it's read-only,
so there's nothing to accidentally resubmit. Submitting posts a formatted summary to
the configured channel. If they haven't submitted after their configured reminder delay
(default 2 hours), they get one follow-up DM.

Standups are posted **under the submitter's own name and avatar** rather than Wavey's, via the
`chat:write.customize` scope. Slack still marks these with a small `APP` badge and the name isn't
a clickable profile link — a bot token can't post as a real person. Doing that properly needs a
per-user OAuth token, which would mean an OAuth redirect endpoint and therefore an inbound HTTP
server this Socket Mode bot doesn't run. If the profile lookup fails the standup is still posted,
just as Wavey with a `@user's standup` header.

## Using the GitHub module

### Setting up the GitHub App

The module authenticates as a GitHub App, so issues are attributed to the app rather than to
someone's personal account, and access is scoped to the repos the app is installed on.

1. Create the app: **Settings → Developer settings → GitHub Apps → New GitHub App** (under your
   org for an org-wide app). Homepage URL can be anything; uncheck **Active** under Webhook -
   the bot polls nothing and receives nothing from GitHub.
2. Under **Permissions → Repository permissions**, set **Issues** to **Read and write**. Nothing
   else is needed. (Metadata: Read-only is added automatically.)
3. Create the app, note the **App ID** → `GITHUB_APP_ID`, then **Generate a private key** and save
   the downloaded `.pem` → `GITHUB_APP_PRIVATE_KEY_PATH` (or inline it as
   `GITHUB_APP_PRIVATE_KEY`, with `\n` escapes or base64-encoded).
4. **Install App** → pick the org/account and the repositories it may file issues into.

The installation covering each repo is looked up automatically and cached, so one app can serve
several orgs; set `GITHUB_APP_INSTALLATION_ID` to pin it to one and skip the lookup. Installation
tokens are short-lived and refreshed automatically. Without an app id and private key the module
logs a warning at startup and stays completely out of the way.

### Filing issues

Set `GITHUB_DEFAULT_REPO` and @-mention the bot anywhere it's a member:

```
@bot Login redirect drops the next param      # issue in GITHUB_DEFAULT_REPO, created immediately
@bot owner/repo Login redirect is broken      # repo as the first positional argument
@bot                                          # button -> a prefilled modal you can edit first
@bot --label bug,ui --assignee octocat Broken # labels and assignees
@bot --force Another angle on this            # second issue for a thread that already has one
```

Anything that isn't a flag or the leading `owner/repo` becomes the title; quote it if it
contains something that looks like a flag. Arguments are parsed with
[`yargs-parser`](https://github.com/yargs/yargs-parser), so `--label=bug`, `-l bug`, and
repeated flags all work. Mentioning the bot with no title opens a modal instead, where you can
edit the repo, title, labels and assignees, add extra context, and choose whether to attach the
transcript.

The issue body is the whole Slack thread rendered as markdown - user mentions, channel
references and links resolved - with a permalink back to Slack, and it's truncated if the thread
is enormous. Created issues are recorded in the `github_issues` table, which is what powers the
"this thread already has an issue" warning.

Issues are opened by the GitHub App itself, so they show up as authored by
*your-app-name[bot]*; the body names the actual Slack reporter.

## Notes / current limitations

- Single-workspace deployment (one bot token, one Socket Mode connection). Multi-workspace/OAuth installs aren't implemented.
- Standup: reminders are sent at most once per day per person - no repeated nagging.
- Standup: weekday/weekend skipping is global (`skip_weekends` in `/standup-setup`), not per-user.
- Standup: participation follows the destination channel, so there's no way to be in the channel
  without getting standups. Upgrading from a version with the opt-in/out toggle will re-enrol
  anyone who had opted out but is still in the channel.
- GitHub: one app identity for the whole workspace - no per-user GitHub auth, and no way to
  restrict which repos people can file into beyond the app's installations.
- GitHub: `app_mention` only fires in conversations the bot has been invited to, so mentions
  elsewhere silently do nothing.
