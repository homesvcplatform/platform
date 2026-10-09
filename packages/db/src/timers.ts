// Durable timers (ADR-015, ADR-026 #3): Graphile Worker in schema `graphile_worker`. The migrator installs the queue
// schema after the SQL migrations and grants the worker role; modules schedule and cancel timers only through
// `platform.schedule_timer` / `platform.cancel_timer` (SECURITY DEFINER) inside the transaction that changes state, so
// a timer exists exactly when its state change committed. `job_key` replace semantics: one timer per key.
// Handlers must be idempotent and re-check state: a timer can fire late, twice, or after the state moved on.
import pg from 'pg';
import { run, runMigrations, Logger as GraphileLogger, type Runner, type TaskList } from 'graphile-worker';
import type { Queryable } from './migrate.ts';

export const TIMER_SCHEMA = 'graphile_worker';
const WORKER_ROLE = 'app_worker';

/** Graphile's own log lines stay out of the structured logs (they may contain payloads). */
const silent = new GraphileLogger(() => () => undefined);

/** Installs or upgrades the queue schema as the migrator, then grants it to the worker role only. Idempotent. */
export async function installTimerQueue(migratorConnectionString: string): Promise<void> {
  await runMigrations({ connectionString: migratorConnectionString, schema: TIMER_SCHEMA, logger: silent });
  const c = new pg.Client({ connectionString: migratorConnectionString });
  await c.connect();
  try {
    await c.query(`REVOKE ALL ON SCHEMA ${TIMER_SCHEMA} FROM PUBLIC`);
    await c.query(`GRANT USAGE ON SCHEMA ${TIMER_SCHEMA} TO ${WORKER_ROLE}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${TIMER_SCHEMA} TO ${WORKER_ROLE}`);
    await c.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${TIMER_SCHEMA} TO ${WORKER_ROLE}`);
    await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${TIMER_SCHEMA} TO ${WORKER_ROLE}`);
  } finally {
    await c.end();
  }
}

export interface TimerRequest {
  /** Task name, e.g. `jobs.visit.tech_no_show`. */
  readonly task: string;
  /** One timer per key: scheduling again replaces it. */
  readonly key: string;
  readonly runAt: Date;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

/** Schedules (or replaces) a timer in the caller's transaction. */
export async function scheduleTimer(c: Queryable, t: TimerRequest): Promise<void> {
  await c.query('SELECT platform.schedule_timer($1, $2, $3, $4)', [t.task, t.key, t.runAt, JSON.stringify(t.payload)]);
}

/** Cancels a pending timer by key in the caller's transaction (no-op when absent or already running). */
export async function cancelTimer(c: Queryable, key: string): Promise<void> {
  await c.query('SELECT platform.cancel_timer($1)', [key]);
}

export interface TimerRunnerOptions {
  readonly pool: pg.Pool;
  readonly tasks: Readonly<Record<string, (payload: unknown) => Promise<void>>>;
  readonly concurrency?: number;
  /** Graphile crontab, e.g. the 1-minute sweeper (`* * * * * jobs.sweep`). */
  readonly crontab?: string;
  readonly pollIntervalMs?: number;
  /** Queue diagnostics (level and message only; payloads are never passed). Silent by default. */
  readonly onLog?: (level: string, message: string) => void;
}

/** Starts a timer runner on the worker pool. `stop()` drains; `kill()` simulates a crash in tests. */
export async function startTimerRunner(o: TimerRunnerOptions): Promise<Runner> {
  const taskList: TaskList = {};
  for (const [name, handler] of Object.entries(o.tasks)) taskList[name] = async (payload) => handler(payload);
  return run({
    pgPool: o.pool, schema: TIMER_SCHEMA, taskList, concurrency: o.concurrency ?? 4, noHandleSignals: true,
    logger: o.onLog ? new GraphileLogger(() => (level, message) => o.onLog?.(level, message)) : silent,
    pollInterval: o.pollIntervalMs ?? 1_000, ...(o.crontab ? { crontab: o.crontab } : {}),
  });
}
