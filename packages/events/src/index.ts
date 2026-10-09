// @hsp/events: the outbox relay and idempotent consumers (Phase 1 01 §5.1, ADR-027 #14). Commands write their events
// to `platform.outbox` in their own transaction (outbox pattern); the relay, running in the worker role on the durable
// queue (Graphile Worker task `platform.outbox.dispatch`, woken by migration 0038's trigger, plus a 1-minute cron),
// hands each event to the consumers registered for its type and marks it published once all of them succeeded.
// - Order: only the oldest pending event of an aggregate is delivered (SKIP LOCKED + "no earlier pending event"), so a
//   consumer sees an aggregate's events in order even with several relays running.
// - At-least-once delivery, exactly-once effect: a consumer records the event in `platform.processed_events` inside its
//   own transaction (`consumeOnce`), so a replay after a crash is a no-op.
// - A failing event blocks only its aggregate; after `maxAttempts` it goes to `platform.dead_letters` for ops.
import type pg from 'pg';
import { withTransaction, type Queryable } from '@hsp/db';
import { newId } from '@hsp/kernel';
import type { Logger } from '@hsp/observability';

export const RELAY_TASK = 'platform.outbox.dispatch' as const;

export interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly cityId: string | null;
  readonly occurredAt: Date;
}

export interface EventConsumer {
  /** Stable consumer name (key of `platform.processed_events`). */
  readonly name: string;
  readonly handles: readonly string[];
  /** Must be idempotent: run the effect and `consumeOnce` in one transaction. */
  handle(event: OutboxEvent): Promise<void>;
}

const SQL = {
  pending: `
    SELECT o.id, o.event_type, o.schema_version, o.aggregate_type, o.aggregate_id, o.aggregate_version, o.payload, o.correlation_id,
           o.city_id, o.occurred_at, o.attempts
      FROM platform.outbox o
     WHERE o.published_at IS NULL
       AND (o.last_attempt_at IS NULL OR o.last_attempt_at <= now() - make_interval(secs => $2::numeric / 1000.0))
       AND NOT EXISTS (SELECT 1 FROM platform.outbox e
                        WHERE e.aggregate_id = o.aggregate_id AND e.published_at IS NULL AND (e.occurred_at, e.id) < (o.occurred_at, o.id))
     ORDER BY o.occurred_at, o.id
     LIMIT $1
       FOR UPDATE OF o SKIP LOCKED`,
  published: `UPDATE platform.outbox SET published_at = now() WHERE id = $1`,
  failed: `UPDATE platform.outbox SET attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`,
  deadLetter: `
    INSERT INTO platform.dead_letters (id, consumer, event_id, job_name, last_error, attempts, payload_ref)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  consume: `INSERT INTO platform.processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
} as const;

/** Every relay statement (B2: platform only). */
export const EVENTS_SQL = SQL;

/**
 * Marks `eventId` as processed by `consumer` in the caller's transaction. False when it was processed before: the
 * caller then skips the effect (exactly-once effect under at-least-once delivery).
 */
export async function consumeOnce(c: Queryable, consumer: string, eventId: string): Promise<boolean> {
  return (await c.query(SQL.consume, [consumer, eventId])).rows.length === 1;
}

/** A short, PII-free failure label for logs and dead letters (an error code or class name, never a message). */
function failureLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 60) : 'UNKNOWN';
}

export interface OutboxRelayOptions {
  readonly pool: pg.Pool;
  readonly consumers: readonly EventConsumer[];
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  /** Upper bound of batches per drain (a drain also picks up events the consumers emit). */
  readonly maxBatches?: number;
  /** A failed event is retried no sooner than this after its last attempt (default 30 s). */
  readonly retryAfterMs?: number;
}

export function createOutboxRelay(o: OutboxRelayOptions) {
  const batchSize = o.batchSize ?? 50;
  const maxAttempts = o.maxAttempts ?? 10;
  const maxBatches = o.maxBatches ?? 20;
  const retryAfterMs = o.retryAfterMs ?? 30_000;
  const byType = new Map<string, EventConsumer[]>();
  for (const consumer of o.consumers) for (const t of consumer.handles) byType.set(t, [...(byType.get(t) ?? []), consumer]);

  async function batch(): Promise<{ delivered: number; failed: number; deadLettered: number; seen: number }> {
    return withTransaction(o.pool, async (c) => {
      const rows = (await c.query(SQL.pending, [batchSize, retryAfterMs])).rows as Record<string, unknown>[];
      let delivered = 0;
      let failed = 0;
      let deadLettered = 0;
      for (const r of rows) {
        const event: OutboxEvent = {
          id: r['id'] as string, type: r['event_type'] as string, schemaVersion: Number(r['schema_version']), aggregateType: r['aggregate_type'] as string,
          aggregateId: r['aggregate_id'] as string, aggregateVersion: Number(r['aggregate_version']), payload: r['payload'] as Record<string, unknown>,
          correlationId: r['correlation_id'] as string, cityId: (r['city_id'] as string | null) ?? null, occurredAt: r['occurred_at'] as Date,
        };
        let failing: { consumer: string; label: string } | null = null;
        for (const consumer of byType.get(event.type) ?? []) {
          try {
            await consumer.handle(event);
          } catch (error) {
            failing = { consumer: consumer.name, label: failureLabel(error) };
            break;
          }
        }
        if (!failing) {
          await c.query(SQL.published, [event.id]);
          delivered += 1;
          continue;
        }
        const attempts = Number(r['attempts']) + 1;
        o.logger.log('warn', 'events.delivery_failed', { eventType: event.type, consumerName: failing.consumer, failure: failing.label, attempts });
        if (attempts >= maxAttempts) {
          await c.query(SQL.deadLetter, [newId(), failing.consumer, event.id, RELAY_TASK, failing.label, attempts,
            JSON.stringify({ outboxId: event.id, eventType: event.type, aggregateId: event.aggregateId })]);
          await c.query(SQL.failed, [event.id]);
          await c.query(SQL.published, [event.id]);
          deadLettered += 1;
        } else {
          await c.query(SQL.failed, [event.id]);
          failed += 1;
        }
      }
      return { delivered, failed, deadLettered, seen: rows.length };
    });
  }

  return {
    /** Delivers pending events until none is left (or `maxBatches`). Safe to run concurrently. */
    async drain(): Promise<{ delivered: number; failed: number; deadLettered: number }> {
      const total = { delivered: 0, failed: 0, deadLettered: 0 };
      for (let i = 0; i < maxBatches; i += 1) {
        const r = await batch();
        total.delivered += r.delivered;
        total.failed += r.failed;
        total.deadLettered += r.deadLettered;
        // Stop when nothing moved: the remaining events are failing (retried by the next wake-up) or locked elsewhere.
        if (r.delivered + r.deadLettered === 0) break;
      }
      return total;
    },
  };
}

export type OutboxRelay = ReturnType<typeof createOutboxRelay>;
