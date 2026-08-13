import type { BotModule, ModuleContext } from "../../core/module.js";
import { registerActions } from "./actions.js";
import { createClientProvider } from "./auth.js";
import type { CreateDeps } from "./create.js";
import { migrations } from "./db.js";
import { registerEvents } from "./events.js";

/**
 * GitHub issue module.
 *
 * @-mention the bot in any channel or thread it's a member of to file an issue:
 *
 *   @bot Fix the login redirect              -> issue in GITHUB_DEFAULT_REPO, created immediately
 *   @bot owner/repo Fix the login redirect   -> repo given as the first positional argument
 *   @bot                                     -> button that opens a prefilled review modal
 *
 * plus `--label bug,ui`, `--assignee octocat` and `--force` (create a second issue
 * for a thread that already has one). The issue body is the whole thread, rendered
 * as markdown, with a permalink back to Slack.
 */
export const githubModule: BotModule = {
  name: "github",
  migrations,
  register(ctx: ModuleContext) {
    const { githubAppId, githubAppPrivateKey } = ctx.config;
    if (!githubAppId || !githubAppPrivateKey) {
      // Registering the app_mention handler without credentials would swallow every
      // mention and answer none of them - stay out of the way instead.
      ctx.logger.warn("github module disabled: set GITHUB_APP_ID and a GitHub App private key to enable it");
      return;
    }
    if (!ctx.config.githubDefaultRepo) {
      ctx.logger.warn("github module: no GITHUB_DEFAULT_REPO set, every mention must name a repo");
    }

    const deps: CreateDeps = {
      db: ctx.db,
      logger: ctx.logger,
      github: createClientProvider({
        appId: githubAppId,
        privateKey: githubAppPrivateKey,
        baseUrl: ctx.config.githubApiBaseUrl,
        installationId: ctx.config.githubAppInstallationId,
        logger: ctx.logger,
      }),
    };

    registerEvents(ctx.app, deps, ctx.config.githubDefaultRepo);
    registerActions(ctx.app, deps);
  },
};
