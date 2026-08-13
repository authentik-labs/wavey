import type { BotModule } from "../core/module.js";
import { githubModule } from "./github/index.js";
import { standupModule } from "./standup/index.js";

/**
 * Every feature the bot ships with. To add a new one: write a module under
 * src/modules/<name>/ that satisfies BotModule and list it here - core
 * (src/index.ts, src/core/*) never needs to change.
 */
export const modules: BotModule[] = [standupModule, githubModule];
