-- Outbox, idempotency and event-processing tables (Phase 1 03 §13 platform, §14.6).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE platform.idempotency_keys (
  actor_key       text NOT NULL CHECK (actor_key ~ '^(user|admin|anon|system):[A-Za-z0-9._:-]{1,80}$'),
  idem_key        uuid NOT NULL,
  endpoint        text NOT NULL,
  request_hash    bytea NOT NULL,
  status          text NOT NULL CHECK (status IN ('IN_FLIGHT','COMPLETED')),
  response_status smallint,
  response_body   bytea,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (actor_key, idem_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX idem_expiry_ix ON platform.idempotency_keys (expires_at);

CREATE TABLE platform.outbox (
  id               uuid PRIMARY KEY,
  event_type       text NOT NULL,
  schema_version   smallint NOT NULL CHECK (schema_version >= 1),
  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  aggregate_version int NOT NULL,
  payload          jsonb NOT NULL CHECK (pg_column_size(payload) <= 16384),
  correlation_id   uuid NOT NULL,
  causation_id     uuid,
  city_id          uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz
);
CREATE INDEX outbox_unpublished_ix ON platform.outbox (occurred_at) WHERE published_at IS NULL;

CREATE TABLE platform.processed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE platform.dead_letters (
  id                   uuid PRIMARY KEY,
  consumer             text NOT NULL,
  event_id             uuid,
  job_name             text NOT NULL,
  last_error           text NOT NULL,
  attempts             int NOT NULL CHECK (attempts >= 1),
  payload_ref          jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  replayed_at          timestamptz,
  replayed_by_admin_id uuid
);

-- request_hash is a digest; response_body may contain confidential data (encrypted by the API when it does).
SELECT platform.classify('platform.idempotency_keys', 'I', 'response_body', 'C');
-- Outbox payloads carry IDs / enums / amounts only (no PII), size-capped above.
SELECT platform.classify('platform.outbox', 'I');
SELECT platform.classify('platform.processed_events', 'I');
SELECT platform.classify('platform.dead_letters', 'I', 'last_error', 'C');

-- Grants (03 §12.1, G-5). The webhook role has no access to platform.
GRANT USAGE ON SCHEMA platform TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT, UPDATE ON platform.idempotency_keys TO app_api, app_admin, app_voice;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_keys TO app_worker;
GRANT INSERT ON platform.outbox TO app_api, app_admin, app_voice;
GRANT SELECT, INSERT, UPDATE ON platform.outbox TO app_worker;
GRANT SELECT, INSERT ON platform.processed_events TO app_worker;
GRANT SELECT, INSERT, UPDATE ON platform.dead_letters TO app_worker;
GRANT SELECT, UPDATE ON platform.dead_letters TO app_admin;
