-- matching: match runs (explainable candidates), exclusive offers, versioned configs, fairness ledger.
-- Phase 1 03 §10, errata G-2 (offer hold during IVR call), G-3 (overlap-based concurrency, enforced in application
-- under a per-technician advisory lock), X-07 (waves deferred).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA matching;

CREATE TABLE matching.match_runs (
  id                uuid PRIMARY KEY,
  visit_id          uuid NOT NULL,   -- ref: jobs.visits
  city_id           uuid NOT NULL,
  config_version_id uuid NOT NULL,
  trigger           text NOT NULL CHECK (trigger IN ('NEW_VISIT','RETRY','REMATCH_AFTER_RELEASE','OPS_MANUAL','NEW_CHECKINS')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  outcome           text CHECK (outcome IN ('ASSIGNED','EXHAUSTED','CANCELLED','SUPERSEDED')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX match_runs_visit_ix ON matching.match_runs (visit_id, started_at DESC);

-- Explainability; 180-day retention, then aggregated.
CREATE TABLE matching.match_candidates (
  match_run_id       uuid NOT NULL REFERENCES matching.match_runs(id),
  technician_user_id uuid NOT NULL,
  eligible           boolean NOT NULL,
  exclusion_reasons  text[] NOT NULL DEFAULT '{}',
  score              numeric(6,4),
  score_breakdown    jsonb,
  rank               smallint CHECK (rank >= 1),
  PRIMARY KEY (match_run_id, technician_user_id),
  CHECK (eligible OR cardinality(exclusion_reasons) >= 1)
);

CREATE TABLE matching.offers (
  id                      uuid PRIMARY KEY,
  visit_id                uuid NOT NULL,   -- ref: jobs.visits
  technician_user_id      uuid NOT NULL,   -- ref: workforce.technician_profiles
  match_run_id            uuid REFERENCES matching.match_runs(id),
  kind                    text NOT NULL CHECK (kind IN ('CASCADE','DIRECT','WAVE')),
  wave_no                 smallint NOT NULL DEFAULT 1 CHECK (wave_no >= 1),
  channel_plan            text NOT NULL CHECK (channel_plan IN ('PUSH','IVR','PUSH_THEN_IVR')),
  earnings_estimate_paise bigint NOT NULL CHECK (earnings_estimate_paise >= 0),
  earnings_range          jsonb,
  sent_at                 timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  held_until              timestamptz,   -- G-2: call end + 30 s, hard cap 6 min (application)
  status                  text NOT NULL CHECK (status IN ('PENDING','INTERESTED','ACCEPTED','DECLINED','EXPIRED','UNREACHABLE','WITHDRAWN')),
  responded_at            timestamptz,
  response_channel        text CHECK (response_channel IN ('APP','IVR','OPS_ON_BEHALF')),
  decline_reason_code     text,
  delivery_attempts       smallint NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  version                 int NOT NULL DEFAULT 0,
  CHECK (expires_at > sent_at),
  CHECK (status NOT IN ('ACCEPTED','DECLINED') OR (responded_at IS NOT NULL AND response_channel IS NOT NULL))
);
CREATE UNIQUE INDEX offer_pending_uq ON matching.offers (visit_id, technician_user_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX offer_accepted_uq ON matching.offers (visit_id) WHERE status = 'ACCEPTED' AND kind <> 'WAVE';
CREATE INDEX offer_tech_pending_ix ON matching.offers (technician_user_id) WHERE status = 'PENDING';
CREATE INDEX offer_expiry_ix ON matching.offers (expires_at) WHERE status = 'PENDING';

CREATE TABLE matching.matching_configs (
  id                  uuid PRIMARY KEY,
  city_id             uuid NOT NULL,
  version_no          int NOT NULL CHECK (version_no >= 1),
  params              jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  status              text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED')),
  approval_request_id uuid,
  activated_at        timestamptz,
  UNIQUE (city_id, version_no),
  CHECK (status <> 'ACTIVE' OR (activated_at IS NOT NULL AND approval_request_id IS NOT NULL))
);
CREATE UNIQUE INDEX matching_config_active_uq ON matching.matching_configs (city_id) WHERE status = 'ACTIVE';

CREATE TABLE matching.fairness_ledger (
  technician_user_id     uuid NOT NULL,
  service_date           date NOT NULL,
  zone_id                uuid NOT NULL,
  eligible_minutes       int NOT NULL DEFAULT 0 CHECK (eligible_minutes >= 0),
  offers_received        int NOT NULL DEFAULT 0 CHECK (offers_received >= 0),
  offers_by_channel      jsonb NOT NULL DEFAULT '{}',
  earnings_offered_paise bigint NOT NULL DEFAULT 0 CHECK (earnings_offered_paise >= 0),
  PRIMARY KEY (technician_user_id, service_date, zone_id)
);

SELECT platform.classify('matching.match_runs', 'I');
SELECT platform.classify('matching.match_candidates', 'I');
SELECT platform.classify('matching.offers', 'I');
SELECT platform.classify('matching.matching_configs', 'I');
SELECT platform.classify('matching.fairness_ledger', 'I');

GRANT USAGE ON SCHEMA matching TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, UPDATE ON matching.offers TO app_api, app_admin, app_voice;   -- accept / decline (TCP-1)
GRANT SELECT ON matching.match_runs, matching.match_candidates, matching.matching_configs, matching.fairness_ledger TO app_admin;
GRANT INSERT, UPDATE ON matching.matching_configs TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON matching.match_runs, matching.match_candidates, matching.offers,
      matching.matching_configs, matching.fairness_ledger TO app_worker;
