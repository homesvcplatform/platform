// Gate 5 (ADR-015, ADR-026 #3): durable timers. Runtime roles schedule only through platform.schedule_timer in their own
// transaction (a rolled-back transaction leaves no timer), one timer per key (replace), cancel by key, and only the
// worker role can run the queue. Throwaway database.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelTimer, scheduleTimer, startTimerRunner, withTransaction } from '@hsp/db';
import { createTestDatabase, type TestDatabase } from '../../db-harness.ts';

let db: TestDatabase;
let api: pg.Pool;
let worker: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  api = new pg.Pool({ connectionString: await db.loginFor('app_api'), max: 2 });
  worker = new pg.Pool({ connectionString: await db.loginFor('app_worker'), max: 6 });
});
afterAll(async () => {
  await api?.end();
  await worker?.end();
  await db?.close();
});

const queueLog: string[] = [];
const pending = async (key: string) =>
  (await db.migrator.query('SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = $1', [key])).rows[0].n as number;

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for the timer');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('durable timers', () => {
  it('a timer exists only if its transaction commits', async () => {
    await expect(withTransaction(api, async (c) => {
      await scheduleTimer(c, { task: 'test.timer.fire', key: 'rollback-1', runAt: new Date(Date.now() + 60_000), payload: {} });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await pending('rollback-1')).toBe(0);
    await withTransaction(api, (c) => scheduleTimer(c, { task: 'test.timer.fire', key: 'commit-1', runAt: new Date(Date.now() + 60_000), payload: {} }));
    expect(await pending('commit-1')).toBe(1);
  });

  it('one timer per key (replace), cancel by key', async () => {
    for (let i = 0; i < 3; i += 1) {
      await withTransaction(api, (c) => scheduleTimer(c, { task: 'test.timer.fire', key: 'replace-1', runAt: new Date(Date.now() + 60_000 + i), payload: { i } }));
    }
    expect(await pending('replace-1')).toBe(1);
    const payload = (await db.migrator.query('SELECT payload FROM graphile_worker._private_jobs WHERE key = $1', ['replace-1'])).rows[0].payload;
    expect(payload).toEqual({ i: 2 });
    await withTransaction(api, (c) => cancelTimer(c, 'replace-1'));
    expect(await pending('replace-1')).toBe(0);
  });

  it('the worker runs due timers once', async () => {
    const fired: unknown[] = [];
    const runner = await startTimerRunner({ pool: worker, tasks: { 'test.timer.fire': async (p) => { fired.push(p); } }, pollIntervalMs: 200,
      onLog: (level, message) => { if (level === 'error' || level === 'warning') queueLog.push(`${level}: ${message}`); } });
    try {
      await withTransaction(api, (c) => scheduleTimer(c, { task: 'test.timer.fire', key: 'due-1', runAt: new Date(Date.now() - 1_000), payload: { n: 1 } }));
      await waitFor(() => fired.length === 1).catch((error: unknown) => {
        throw new Error(`${(error as Error).message}; queue log: ${queueLog.slice(0, 5).join(' | ')}`);
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(fired).toEqual([{ n: 1 }]);
      expect(await pending('due-1')).toBe(0);
    } finally {
      await runner.stop();
    }
  });

  it('invalid tasks or keys are refused; runtime roles other than the worker can not touch the queue directly', async () => {
    await expect(api.query('SELECT platform.schedule_timer($1, $2, now(), $3)', ['Bad Task', 'k-1', '{}'])).rejects.toMatchObject({ code: 'HS040' });
    await expect(api.query('SELECT platform.schedule_timer($1, $2, now(), $3)', ['test.timer.fire', 'x', '{}'])).rejects.toMatchObject({ code: 'HS040' });
    await expect(api.query('SELECT platform.schedule_timer($1, $2, now(), $3)', ['test.timer.fire', 'k-arr', '[]'])).rejects.toMatchObject({ code: 'HS040' });
    await expect(api.query('SELECT count(*) FROM graphile_worker.jobs')).rejects.toMatchObject({ code: '42501' });
    await expect(api.query("SELECT graphile_worker.add_job('test.timer.fire', '{}'::json)")).rejects.toMatchObject({ code: '42501' });
    expect((await worker.query('SELECT count(*)::int AS n FROM graphile_worker.jobs')).rows[0].n).toBeGreaterThanOrEqual(0);
  });
});
