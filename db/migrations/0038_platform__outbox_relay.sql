-- platform (Gate 6, ADR-027 #14, Phase 1 01 §5.1): the outbox relay. Every transaction that writes outbox rows also
-- wakes the relay task on the durable queue (Graphile Worker, ADR-015) through platform.schedule_timer, so delivery
-- starts within the queue's poll / notify latency instead of the 1-minute fallback cron. One coalesced job key: many
-- inserts schedule one pending dispatch. The relay (worker role only) records failed deliveries in `attempts`; after the
-- retry limit the event goes to platform.dead_letters. Consumers are idempotent through platform.processed_events.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE platform.outbox ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE platform.outbox ADD COLUMN last_attempt_at timestamptz;
-- The relay delivers only the oldest pending event of each aggregate (per-aggregate order, even with concurrent relays).
-- The runner wraps each migration in a transaction, so CONCURRENTLY isn't available; the table is small before pilot.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX outbox_pending_aggregate_ix ON platform.outbox (aggregate_id, occurred_at, id) WHERE published_at IS NULL;

CREATE FUNCTION platform.wake_outbox_relay() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM platform.schedule_timer('platform.outbox.dispatch', 'platform:outbox:dispatch', now(), '{}'::jsonb);
  RETURN NULL;
END $$;

CREATE TRIGGER wake_relay AFTER INSERT ON platform.outbox FOR EACH STATEMENT EXECUTE FUNCTION platform.wake_outbox_relay();
REVOKE ALL ON FUNCTION platform.wake_outbox_relay() FROM PUBLIC;
