// Test helper for the kill-worker recovery test (Gate 5): a timer runner whose handler for `task` takes the job and
// never finishes, like a worker process that died in the middle of it.
import type pg from 'pg';
import { startTimerRunner } from '@hsp/db';

export async function startStuckTimerRunner(pool: pg.Pool, task: string, onTaken: () => void) {
  return startTimerRunner({ pool, pollIntervalMs: 100, tasks: { [task]: () => {
    onTaken();
    return new Promise<void>(() => undefined);
  } } });
}
