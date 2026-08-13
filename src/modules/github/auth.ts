import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Logger } from "../../core/logger.js";
import { AppNotInstalledError, isRequestError } from "./github.js";

export interface ClientProviderOptions {
  appId: string;
  privateKey: string;
  baseUrl: string;
  /** Skips the per-repo installation lookup when the app only serves one installation. */
  installationId?: number;
  logger: Logger;
}

export interface ClientProvider {
  /** An Octokit authenticated as the installation that covers `owner/repo`. */
  octokitForRepo(repo: string): Promise<Octokit>;
}

/**
 * GitHub App authentication.
 *
 * Octokit's app auth strategy owns the JWT signing and keeps each installation's
 * short-lived access token fresh, so all we cache here is the repo -> installation
 * mapping and one Octokit per installation.
 */
export function createClientProvider(options: ClientProviderOptions): ClientProvider {
  const { appId, privateKey, baseUrl, installationId } = options;
  const logger = options.logger.child({ module: "github" });

  // Octokit logs failed requests through this; without it they'd go to the console
  // and bypass pino entirely.
  const log = {
    debug: (message: string) => logger.debug(message),
    info: (message: string) => logger.debug(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
  };

  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey }, baseUrl, log });
  const installationIds = new Map<string, number>();
  const clients = new Map<number, Octokit>();

  async function installationIdFor(repo: string): Promise<number> {
    if (installationId !== undefined) return installationId;

    const cached = installationIds.get(repo);
    if (cached !== undefined) return cached;

    const [owner, name] = repo.split("/");
    try {
      const { data } = await appOctokit.rest.apps.getRepoInstallation({ owner: owner!, repo: name! });
      installationIds.set(repo, data.id);
      return data.id;
    } catch (err) {
      // 404 means no installation covers this repo - including the case where the
      // repo doesn't exist, which the app has no way to tell apart.
      if (isRequestError(err) && err.status === 404) throw new AppNotInstalledError(repo);
      throw err;
    }
  }

  return {
    async octokitForRepo(repo: string): Promise<Octokit> {
      const id = await installationIdFor(repo);
      const cached = clients.get(id);
      if (cached) return cached;

      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId: id },
        baseUrl,
        log,
      });
      clients.set(id, octokit);
      return octokit;
    },
  };
}
