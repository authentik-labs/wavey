import yargsParser from "yargs-parser";
import type { ParsedMention } from "./types.js";

/** `owner/repo` - GitHub allows letters, digits, dot, dash and underscore in both halves. */
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** One or more `<@U123>` / `<@U123|name>` mentions at the start of the text, plus any trailing punctuation. */
const LEADING_MENTIONS_RE = /^\s*(?:<@[UWB][A-Z0-9]+(?:\|[^>]*)?>[\s,:]*)+/;

/** GitHub rejects titles longer than 256 characters. */
export const MAX_TITLE_CHARS = 250;

const PARSER_OPTS: yargsParser.Options = {
  string: ["repo", "label", "assignee"],
  boolean: ["force"],
  array: ["label", "assignee"],
  alias: { repo: ["r"], label: ["l"], assignee: ["a"] },
  configuration: {
    "camel-case-expansion": false,
    "dot-notation": false,
    // Without this, `--label bug Fix the thing` swallows the whole title into the label array.
    "greedy-arrays": false,
    // Titles are text, not numbers: keep "Deploy 42 failed" intact.
    "parse-numbers": false,
    "parse-positional-numbers": false,
    "boolean-negation": false,
    "short-option-groups": false,
    // Anything we didn't declare stays part of the title rather than becoming a flag.
    "unknown-options-as-args": true,
  },
};

export function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, "").trim();
}

/** Flattens `--label bug,ui -l chore` into `["bug", "ui", "chore"]`. */
function toList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of String(entry).split(",")) {
      const trimmed = part.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

/**
 * yargs-parser groups `"a quoted title"` into one token but leaves the quotes on
 * positionals, so strip a single wrapping pair. Quoting is how you keep something
 * that looks like a flag inside the title.
 */
function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.length > 1 && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

export function parseMentionText(text: string): ParsedMention {
  const argv = yargsParser(stripLeadingMentions(text), PARSER_OPTS);
  const positionals = argv._.map((entry) => unquote(String(entry)));

  let repo = typeof argv.repo === "string" && argv.repo.trim() ? argv.repo.trim() : undefined;
  const first = positionals[0];
  if (!repo && first && REPO_RE.test(first)) {
    repo = first;
    positionals.shift();
  }

  return {
    repo,
    title: truncateTitle(positionals.join(" ").trim()),
    labels: toList(argv.label),
    assignees: toList(argv.assignee),
    force: argv.force === true,
  };
}

export function truncateTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TITLE_CHARS ? `${collapsed.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : collapsed;
}

/** Best-effort issue title from a message body: its first non-empty line. */
export function titleFromText(text: string): string {
  const firstLine = stripLeadingMentions(text)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncateTitle(firstLine ?? "");
}
