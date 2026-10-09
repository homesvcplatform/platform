// Gate 5 exit criterion "kill-worker timer recovery" (ADR-015, ADR-026 #3, 06 §13): a worker dies while holding a due
// timer; the state change never happens in that worker. A second worker's sweeper applies it exactly once, a late
// re-run of the dead worker's timer is a no-op, and the new worker keeps processing fresh timers. Throwaway database.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralKeyring } from '@hsp/adapter-kms-local';
import { ManualClock, newId } from '@hsp/kernel';
import { newPublicRef, TIMER_TASKS } from '@hsp/module-jobs';
import { createLogger } from '@hsp/observability';
import { MemoryRateLimitStore } from '@hsp/security';
import { createTestDatabase, startStuckTimerRunner, type TestDatabase } from '@hsp/testing';
import { composeWorker } from '../bootstrap.ts';

let db: TestDatabase;
let urlA: string;
let poolA: pg.Pool;
let poolB: pg.Pool;
const clock = new ManualClock(new Date());
const env = { APP_ENV: 'test' };

beforeAll(async () => {
  db = await createTestDatabase();
  urlA = await db.loginFor('app_worker');
  poolA = new pg.Pool({ connectionString: urlA, max: 4 });
  poolB = new pg.Pool({ connectionString: await db.loginFor('app_worker'), max: 6 });
});
afterAll(async () => {
  await poolA?.end().catch(() => undefined);
  await poolB?.end();
  await db?.close();
});

const worker = () => composeWorker({ pool: poolB, clock, logger: createLogger('hsp-worker-test', 'error', () => undefined, () => clock.now()),
  kms: createEphemeralKeyring(env).forRole('worker'), appEnv: 'test', rateLimitStore: new MemoryRateLimitStore(), jobsCodeKey: randomBytes(32),
  requestHashKey: randomBytes(32) });

async function plannedAsapVisit(): Promise<string> {
  const c = db.migrator;
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('hsp.actor_type', 'SYSTEM', true), set_config('hsp.channel', 'TEST', true), set_config('hsp.correlation_id', $1, true)`, [newId()]);
    const jobId = newId();
    const visitId = newId();
    await c.query(`INSERT INTO jobs.jobs (id, public_ref, customer_user_id, city_id, zone_id, locality_id, service_type_id, address_id, address_snapshot_enc,
        channel, payment_preference, onsite_adult, created_by_actor_type, created_by_actor_id, customer_verified, client_request_id, status, visit_fee_snapshot_id)
      VALUES ($1, $2, $3, $4, $4, $4, $4, $4, $5, 'PWA', 'EITHER', 'SELF', 'CUSTOMER', $3, true, $6, 'REQUESTED', $4)`,
    [jobId, newPublicRef(), newId(), newId(), randomBytes(16), newId()]);
    await c.query(`INSERT INTO jobs.visits (id, job_id, city_id, locality_id, sequence_no, purposes, required_service_type_id, required_capability,
        service_window, urgency, status, start_code_hash, visit_code)
      VALUES ($1, $2, $3, $3, 1, '{DIAGNOSIS}', $3, 'DIAGNOSE', tstzrange(now(), now() + interval '4 hours'), 'ASAP', 'PLANNED', $4, '1234')`,
    [visitId, jobId, newId(), randomBytes(32)]);
    await c.query('SELECT platform.schedule_timer($1, $2, now(), $3)', [TIMER_TASKS.matchStart, `visit:${visitId}:matchStart`, JSON.stringify({ visitId })]);
    await c.query('COMMIT');
    return visitId;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

const status = async (visitId: string) => (await db.migrator.query('SELECT status FROM jobs.visits WHERE id = $1', [visitId])).rows[0]?.status as string;
const matchingTransitions = async (visitId: string) => (await db.migrator.query(
  "SELECT count(*)::int AS n FROM jobs.visit_status_history WHERE visit_id = $1 AND to_status = 'MATCHING'", [visitId])).rows[0].n as number;

async function waitFor(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('kill-worker timer recovery', () => {
  it('a timer held by a dead worker is recovered by the sweeper exactly once; the new worker keeps processing timers', async () => {
    const visitId = await plannedAsapVisit();

    // Worker A takes the due timer and dies in the middle of it (its handler never completes, its connections are cut).
    let taken = false;
    const runnerA = await startStuckTimerRunner(poolA, TIMER_TASKS.matchStart, () => {
      taken = true;
    });
    await waitFor(async () => taken);
    expect((await db.migrator.query('SELECT locked_at FROM graphile_worker._private_jobs WHERE key = $1', [`visit:${visitId}:matchStart`])).rows[0]?.locked_at)
      .not.toBeNull();
    void runnerA.kill().catch(() => undefined);
    const loginA = new URL(urlA).username;
    await db.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [loginA]);
    expect(await status(visitId)).toBe('PLANNED');

    // Worker B: the 1-minute sweeper repairs the overdue state.
    const b = worker();
    const counts = await b.jobs.sweep();
    expect(counts['matchStart']).toBeGreaterThanOrEqual(1);
    expect(await status(visitId)).toBe('MATCHING');
    expect(await matchingTransitions(visitId)).toBe(1);

    // The dead worker's timer, run late, changes nothing (handlers re-check state).
    await b.jobs.timerTasks()[TIMER_TASKS.matchStart]?.({ visitId });
    expect(await matchingTransitions(visitId)).toBe(1);

    // Worker B processes fresh timers: the matching SLA, due now, makes the visit UNFULFILLED.
    clock.advance(31 * 60_000);
    const runnerB = await b.startTimers({ pollIntervalMs: 100, withSweeper: false });
    try {
      await db.migrator.query('SELECT platform.schedule_timer($1, $2, now(), $3)', [TIMER_TASKS.matchSla, `visit:${visitId}:matchSla`, JSON.stringify({ visitId })]);
      await waitFor(async () => (await status(visitId)) === 'UNFULFILLED');
    } finally {
      await runnerB.stop();
    }
    expect(await matchingTransitions(visitId)).toBe(1);
  });
});
