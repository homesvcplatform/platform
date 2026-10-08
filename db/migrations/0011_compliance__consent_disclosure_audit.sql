-- compliance: consent records, disclosure events (who saw an exact address/contact, when) and the audit log.
-- All three are append-only (03 §12.2). The audit hash chain is computed by the audit writer (Gate 3).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA compliance;

CREATE TABLE compliance.consent_events (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL,   -- ref: identity.users
  purpose        text NOT NULL CHECK (purpose IN ('SERVICE_DELIVERY','CALL_RECORDING','LOCATION_ONCE','MARKETING','SEGMENT_STATISTICS',
                                                  'BACKGROUND_VERIFICATION','WORKER_ATTRIBUTES','BENEFITS_REFERRAL')),
  action         text NOT NULL CHECK (action IN ('GRANTED','WITHDRAWN')),
  notice_id      uuid NOT NULL,
  notice_version text NOT NULL,
  locale         text NOT NULL CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  channel        text NOT NULL CHECK (channel IN ('PWA','APP','IVR','AGENT_ASSISTED','OPS_CALL')),
  evidence       jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),   -- {otp_challenge_id | session_id | call_session_id}
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_user_purpose_ix ON compliance.consent_events (user_id, purpose, created_at DESC);

CREATE TABLE compliance.disclosure_events (
  id              uuid NOT NULL,
  visit_id        uuid NOT NULL,   -- ref: jobs.visits
  viewer_type     text NOT NULL CHECK (viewer_type IN ('TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  viewer_id       uuid NOT NULL,
  data_kind       text NOT NULL CHECK (data_kind IN ('EXACT_ADDRESS','MASKED_CALL','PROBLEM_MEDIA','ACCESS_NOTES')),
  channel         text NOT NULL CHECK (channel IN ('APP','IVR','ADMIN_CONSOLE','AGENT_WEB')),
  call_session_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX disclosure_visit_ix ON compliance.disclosure_events (visit_id, created_at);

CREATE TABLE compliance.audit_logs (
  id               uuid NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id         uuid,
  actor_session_id uuid,
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      uuid,
  city_id          uuid,
  outcome          text NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILED')),
  reason_code      text,
  change_summary   jsonb,   -- field names + redacted diffs, never PII values
  request_id       uuid,
  ip_hash          bytea,
  ua_hash          bytea,
  chain_partition  text NOT NULL,
  prev_hash        bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
  row_hash         bytea NOT NULL CHECK (octet_length(row_hash) = 32),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX audit_resource_ix ON compliance.audit_logs (resource_type, resource_id, occurred_at);
CREATE INDEX audit_actor_ix ON compliance.audit_logs (actor_type, actor_id, occurred_at);

SELECT platform.ensure_monthly_partitions('compliance.disclosure_events', 1, 3);
SELECT platform.ensure_monthly_partitions('compliance.audit_logs', 1, 3);

SELECT platform.make_append_only('compliance.consent_events');
SELECT platform.make_append_only('compliance.disclosure_events');
SELECT platform.make_append_only('compliance.audit_logs');

SELECT platform.classify('compliance.consent_events', 'I');
SELECT platform.classify('compliance.disclosure_events', 'I');
SELECT platform.classify('compliance.audit_logs', 'I', 'change_summary', 'C', 'ip_hash', 'C', 'ua_hash', 'C');

INSERT INTO platform.archive_policies (table_schema, table_name, hot_retention, archive_mode, legal_basis) VALUES
  ('compliance', 'disclosure_events', interval '1 year', 'DROP_WITHOUT_ARCHIVE', 'Phase 1 03 §14.9: disclosure events 1 y, partition drop'),
  ('compliance', 'audit_logs', interval '1 year', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: 1 y hot + WORM archive to 8 y (legal confirmation pending)');

GRANT USAGE ON SCHEMA compliance TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT ON compliance.consent_events TO app_api, app_admin, app_worker;
GRANT INSERT ON compliance.disclosure_events, compliance.audit_logs TO app_api, app_voice;
GRANT SELECT, INSERT ON compliance.disclosure_events, compliance.audit_logs TO app_admin, app_worker;
