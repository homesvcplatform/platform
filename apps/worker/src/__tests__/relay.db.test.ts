// Gate 6 (ADR-027 #14, Phase 1 01 §5.1): the outbox relay. Per-aggregate order and exactly-once effects with concurrent
// relays (SKIP LOCKED + "oldest pending per aggregate" + processed_events), a failing event blocking only its aggregate
// until it is dead-lettered, and the wake-up path: an outbox insert schedules the dispatch job, which the worker's
// Graphile runner executes within seconds (QuoteApproved → repair order SLO p95 < 5 s, X-03). Throwaway database.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralKeyring } from '@hsp/adapter-kms-local';
import { consumeOnce, createOutboxRelay, type EventConsumer, type OutboxEvent } from '@hsp/events';
import { ManualClock, newId } from '@hsp/kernel';
import { createLogger } from '@hsp/observability';
import { MemoryRateLimitStore } from '@hsp/security';
import { createTestDatabase, type TestDatabase } from '@hsp/testing';
import { composeWorker } from '../bootstrap.ts';

let db: TestDatabase;
let pool: pg.Pool;
const logger = createLogger('hsp-relay-test', 'error', () => undefined);

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: await db.loginFor('app_worker'), max: 8 });
});
afterAll(async () => {
  await pool?.end();
  await db?.close();
});

let tick = Date.parse('2026-10-01T00:00:00Z');
async function emit(aggregateId: string, type = 'TestEvent'): Promise<string> {
  const id = newId();
  tick += 1000;
  await db.migrator.query(`INSERT INTO platform.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id, occurred_at)
    VALUES ($1, $2, 1, 'Test', $3, 0, $4, $5, $6)`, [id, type, aggregateId, JSON.stringify({ n: tick }), newId(), new Date(tick)]);
  return id;
}

/** A consumer recording what it saw (in order) and its effect exactly once (processed_events in its own transaction). */
function recorder(name: string, failFor: Set<string> = new Set()) {
  const seen: OutboxEvent[] = [];
  const consumer: EventConsumer = {
    name, handles: ['TestEvent'],
    async handle(e) {
      if (failFor.has(e.aggregateId)) throw Object.assign(new Error('boom'), { code: 'TEST_FAILURE' });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (await consumeOnce(c, name, e.id)) seen.push(e);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    },
  };
  return { consumer, seen };
}

describe('outbox relay (ADR-027 #14)', () => {
  it('delivers every event once, in order per aggregate, with two relays draining concurrently', async () => {
    const aggregates = Array.from({ length: 6 }, () => newId());
    const ids = new Map<string, string[]>(aggregates.map((a) => [a, []]));
    for (let i = 0; i < 5; i += 1) for (const a of aggregates) ids.get(a)?.push(await emit(a));
    const r = recorder('test-order');
    const relayA = createOutboxRelay({ pool, consumers: [r.consumer], logger, batchSize: 4, retryAfterMs: 0 });
    const relayB = createOutboxRelay({ pool, consumers: [r.consumer], logger, batchSize: 4, retryAfterMs: 0 });
    for (let round = 0; round < 10; round += 1) await Promise.all([relayA.drain(), relayB.drain()]);
    expect(r.seen).toHaveLength(30);
    expect(new Set(r.seen.map((e) => e.id)).size).toBe(30);
    for (const a of aggregates) expect(r.seen.filter((e) => e.aggregateId === a).map((e) => e.id)).toEqual(ids.get(a));
    expect((await db.migrator.query('SELECT count(*)::int AS n FROM platform.outbox WHERE aggregate_id = ANY($1) AND published_at IS NULL', [aggregates])).rows[0])
      .toEqual({ n: 0 });
  });

  it('a failing event blocks only its aggregate, is retried, then dead-lettered (no PII, a failure label only)', async () => {
    const bad = newId();
    const good = newId();
    const badFirst = await emit(bad);
    const badSecond = await emit(bad);
    await emit(good);
    const failing = new Set([bad]);
    const r = recorder('test-dead', failing);
    const relay = createOutboxRelay({ pool, consumers: [r.consumer], logger, maxAttempts: 3, retryAfterMs: 0 });
    await relay.drain();
    expect(r.seen.map((e) => e.aggregateId)).toEqual([good]); // the other aggregate isn't held up
    expect((await db.migrator.query('SELECT published_at FROM platform.outbox WHERE id = $1', [badSecond])).rows[0]).toEqual({ published_at: null });
    const deadOf = async (id: string) => (await db.migrator.query(
      'SELECT consumer, event_id, job_name, last_error, attempts FROM platform.dead_letters WHERE event_id = $1', [id])).rows[0];
    for (let i = 0; i < 5 && !(await deadOf(badFirst)); i += 1) await relay.drain();
    expect(await deadOf(badFirst)).toEqual({ consumer: 'test-dead', event_id: badFirst, job_name: 'platform.outbox.dispatch', last_error: 'TEST_FAILURE', attempts: 3 });
    expect(r.seen.map((e) => e.id)).not.toContain(badSecond); // still blocked behind the failing head until it was dead-lettered
    failing.clear();
    await relay.drain();
    expect(r.seen.map((e) => e.id)).toContain(badSecond);
    expect(r.seen.map((e) => e.id)).not.toContain(badFirst);
  });

  it('an outbox insert wakes the relay on the worker runner: the event is published within seconds', async () => {
    const clock = new ManualClock(new Date());
    const worker = composeWorker({ pool, clock, logger, kms: createEphemeralKeyring({ APP_ENV: 'test' }).forRole('worker'), appEnv: 'test',
      rateLimitStore: new MemoryRateLimitStore(), jobsCodeKey: randomBytes(32), requestHashKey: randomBytes(32), relayRetryAfterMs: 0 });
    const runner = await worker.startTimers({ pollIntervalMs: 200, withSweeper: false });
    try {
      const started = Date.now();
      const id = await emit(newId(), 'UnconsumedEvent');
      let published = false;
      while (!published && Date.now() - started < 10_000) {
        published = (await db.migrator.query('SELECT published_at IS NOT NULL AS p FROM platform.outbox WHERE id = $1', [id])).rows[0]?.p === true;
        if (!published) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(published).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await runner.stop();
    }
  });
});
