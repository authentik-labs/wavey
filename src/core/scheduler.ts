import type { Logger } from "./logger.js";

export type TickHandler = (now: Date) => void | Promise<void>;

/**
 * Minimal tick-based scheduler shared by all modules. Modules that need
 * time-based behavior (daily prompts, reminders, weekly digests, ...)
 * register a handler here instead of each spinning up their own timer.
 */
export class Scheduler {
  private handlers: { name: string; handler: TickHandler }[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  onTick(name: string, handler: TickHandler): void {
    this.handlers.push({ name, handler });
  }

  start(): void {
    const tick = () => {
      void this.runOnce();
    };
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce(): Promise<void> {
    const now = new Date();
    for (const { name, handler } of this.handlers) {
      try {
        await handler(now);
      } catch (err) {
        this.logger.error({ err, handler: name }, "scheduler handler failed");
      }
    }
  }
}
