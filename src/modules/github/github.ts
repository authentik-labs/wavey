import { RequestError } from "@octokit/request-error";
import type { Octokit } from "@octokit/rest";

const REQUEST_TIMEOUT_MS = 10_000;

/** The GitHub App authenticates fine, but isn't installed where we need it. */
export class AppNotInstalledError extends Error {
  constructor(readonly repo: string) {
    super(`the GitHub App is not installed on ${repo}`);
    this.name = "AppNotInstalledError";
  }
}

/**
 * `instanceof RequestError` alone is unreliable when more than one copy of
 * @octokit/request-error ends up in the tree, so fall back to its shape.
 */
export function isRequestError(err: unknown): err is RequestError {
  if (err instanceof RequestError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    "request" in err
  );
}

export interface CreateIssueOptions {
  /** `owner/repo`. */
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface CreatedIssue {
  number: number;
  htmlUrl: string;
}

export async function createIssue(octokit: Octokit, options: CreateIssueOptions): Promise<CreatedIssue> {
  const { repo, title, body, labels, assignees } = options;
  const [owner, name] = repo.split("/");

  const { data } = await octokit.rest.issues.create({
    owner: owner!,
    repo: name!,
    title,
    body,
    ...(labels?.length ? { labels } : {}),
    ...(assignees?.length ? { assignees } : {}),
    request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });

  return { number: data.number, htmlUrl: data.html_url };
}

/** Turns a failure from any of the GitHub calls into something worth showing a Slack user. */
export function describeGitHubError(err: unknown, repo: string): string {
  if (err instanceof AppNotInstalledError) {
    return `The GitHub App isn't installed on \`${repo}\` (or the installation doesn't grant access to it). Install it from the app's settings page and try again.`;
  }
  if (!isRequestError(err)) {
    return `Couldn't create the issue in \`${repo}\`: ${err instanceof Error ? err.message : String(err)}`;
  }

  const data = err.response?.data as { message?: string; errors?: unknown[] } | undefined;
  // Octokit's err.message already has the raw `errors` array JSON appended to it,
  // so build the user-facing text from the response body instead of re-appending.
  const message = data?.message ?? err.message;
  const details = Array.isArray(data?.errors)
    ? data.errors.map((e) =>
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : JSON.stringify(e),
      )
    : [];
  const suffix = details.length ? ` (${details.join("; ")})` : "";

  switch (err.status) {
    case 401:
      return `GitHub rejected the app credentials (401). Check \`GITHUB_APP_ID\` and the private key${suffix}.`;
    case 403:
      return `GitHub denied the request (403): ${message}${suffix}`;
    case 404:
      return `Couldn't find \`${repo}\`, or the app installation can't see it (404). Check the repo name and that the installation includes it.`;
    case 410:
      return `Issues are disabled for \`${repo}\` (410).`;
    case 422:
      return `GitHub rejected the issue (422): ${message}${suffix}`;
    default:
      return `Couldn't create the issue in \`${repo}\`: ${message}${suffix}`;
  }
}
