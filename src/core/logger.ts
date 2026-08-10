import pino from "pino";
import type { AppConfig } from "./config.js";

export type Logger = pino.Logger;

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  });
}
