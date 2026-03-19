import { LoggerInterface } from '../types';

interface ScheduledTask {
  id: string;
  name: string;
  fn: () => Promise<void> | void;
  intervalMs: number;
  timer?: ReturnType<typeof setInterval>;
  lastRun?: number;
  running: boolean;
}

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private logger: LoggerInterface;

  constructor(logger: LoggerInterface) {
    this.logger = logger;
  }

  register(id: string, name: string, fn: () => Promise<void> | void, intervalMs: number): void {
    if (this.tasks.has(id)) {
      this.cancel(id);
    }

    this.tasks.set(id, {
      id,
      name,
      fn,
      intervalMs,
      running: false,
    });

    this.logger.debug(`Task scheduled: ${name} (every ${intervalMs / 1000}s)`);
  }

  start(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.running) return;

    task.running = true;
    task.timer = setInterval(async () => {
      try {
        await task.fn();
        task.lastRun = Date.now();
      } catch (err) {
        this.logger.error(`Scheduled task "${task.name}" failed`, err);
      }
    }, task.intervalMs);

    // Run immediately on start
    Promise.resolve(task.fn()).catch(err => {
      this.logger.error(`Scheduled task "${task.name}" initial run failed`, err);
    });

    this.logger.info(`Task started: ${task.name}`);
  }

  startAll(): void {
    for (const id of this.tasks.keys()) {
      this.start(id);
    }
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    if (task.timer) {
      clearInterval(task.timer);
    }
    task.running = false;
    this.tasks.delete(id);
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      if (task.timer) {
        clearInterval(task.timer);
      }
      task.running = false;
    }
    this.tasks.clear();
  }

  getStatus(): Array<{ id: string; name: string; running: boolean; lastRun?: number; interval: number }> {
    return Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      running: t.running,
      lastRun: t.lastRun,
      interval: t.intervalMs,
    }));
  }
}
