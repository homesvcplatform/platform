-- workforce: technicians, per-service-type skills (no generic "appliance technician"), service areas, availability,
-- check-ins, presence, one-time location shares, payout methods, field agents. Phase 1 03 §6, §8.1, INV-26.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA workforce;

CREATE TABLE workforce.technician_profiles (
  user_id                     uuid PRIMARY KEY,   -- ref: identity.users
  legal_name_enc              bytea NOT NULL,
  display_name                text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 40),
  photo_file_id               uuid,               -- ref: files.file_objects
  device_mode                 text NOT NULL CHECK (device_mode IN ('SMARTPHONE','BASIC_PHONE','AGENT_ASSISTED')),
  city_id                     uuid NOT NULL,      -- ref: geo.cities
  home_locality_id            uuid NOT NULL,      -- ref: geo.localities
  languages                   text[] NOT NULL CHECK (cardinality(languages) >= 1),
  experience_years            smallint CHECK (experience_years BETWEEN 0 AND 60),
  birth_year                  smallint NOT NULL CHECK (birth_year BETWEEN 1940 AND 2100),
  onboarding_status           text NOT NULL CHECK (onboarding_status IN ('DRAFT','DOCS_PENDING','IN_VERIFICATION','TRAINING','READY')),
  status                      text NOT NULL CHECK (status IN ('PROBATION','ACTIVE','PAUSED','SUSPENDED','OFFBOARDED')),
  capacity                    smallint NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 5),
  worker_attributes_enc       bytea,
  accepts_women_only_requests boolean NOT NULL DEFAULT false,
  ivr_locale                  text NOT NULL CHECK (ivr_locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  preferred_offer_call_window int4range CHECK (preferred_offer_call_window IS NULL
                                               OR (lower(preferred_offer_call_window) >= 0 AND upper(preferred_offer_call_window) <= 1440)),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     int NOT NULL DEFAULT 0
);
CREATE INDEX tech_city_status_ix ON workforce.technician_profiles (city_id, status);

CREATE TABLE workforce.technician_skills (
  id                   uuid PRIMARY KEY,
  technician_user_id   uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  service_type_id      uuid NOT NULL,   -- ref: catalog.service_types
  specialization_id    uuid,            -- ref: catalog.specializations
  level                text NOT NULL CHECK (level IN ('CLAIMED','ASSESSED','CERTIFIED')),
  can_diagnose         boolean NOT NULL DEFAULT true,
  can_repair           boolean NOT NULL DEFAULT true,
  verified_by_admin_id uuid,
  verified_at          timestamptz,
  valid_until          timestamptz,
  status               text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (level = 'CLAIMED' OR (verified_by_admin_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (can_diagnose OR can_repair)
);
CREATE UNIQUE INDEX tech_skill_uq ON workforce.technician_skills (technician_user_id, service_type_id, specialization_id)
  NULLS NOT DISTINCT WHERE status = 'ACTIVE';
CREATE INDEX tech_skill_lookup_ix ON workforce.technician_skills (service_type_id, specialization_id) WHERE status = 'ACTIVE';

CREATE TABLE workforce.technician_service_areas (
  id                 uuid PRIMARY KEY,
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  locality_id        uuid NOT NULL,   -- ref: geo.localities
  priority           text NOT NULL CHECK (priority IN ('PRIMARY','SECONDARY')),
  max_radius_km      numeric(4,1) CHECK (max_radius_km BETWEEN 0.5 AND 50),
  created_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz
);
CREATE UNIQUE INDEX tsa_uq ON workforce.technician_service_areas (technician_user_id, locality_id) WHERE removed_at IS NULL;
CREATE INDEX tsa_locality_ix ON workforce.technician_service_areas (locality_id) WHERE removed_at IS NULL;

CREATE TABLE workforce.technician_weekly_availability (
  id                 uuid PRIMARY KEY,
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  weekday            smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  minutes            int4range NOT NULL CHECK (lower(minutes) >= 0 AND upper(minutes) <= 1440 AND NOT isempty(minutes)),
  effective_from     date NOT NULL,
  effective_to       date,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (technician_user_id WITH =, weekday WITH =, minutes WITH &&,
                      daterange(effective_from, effective_to) WITH &&)
);

CREATE TABLE workforce.technician_availability_overrides (
  id                 uuid PRIMARY KEY,
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  period             tstzrange NOT NULL CHECK (NOT isempty(period)),
  kind               text NOT NULL CHECK (kind IN ('UNAVAILABLE','EXTRA_AVAILABLE')),
  reason_code        text,
  created_via        text NOT NULL CHECK (created_via IN ('APP','IVR','AGENT','OPS')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tao_period_gix ON workforce.technician_availability_overrides USING gist (technician_user_id, period);

-- Append-only: the latest row per (technician, service_date) wins.
CREATE TABLE workforce.technician_daily_checkins (
  id                 uuid PRIMARY KEY,
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  service_date       date NOT NULL,
  available          boolean NOT NULL,
  locality_id        uuid,   -- ref: geo.localities; must be a registered area (application check)
  channel            text NOT NULL CHECK (channel IN ('APP','IVR','MISSED_CALL','AGENT','OPS')),
  call_session_id    uuid,   -- ref: voice.call_sessions
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT available OR locality_id IS NOT NULL)
);
CREATE INDEX checkin_latest_ix ON workforce.technician_daily_checkins (technician_user_id, service_date, created_at DESC);
CREATE INDEX checkin_pool_ix ON workforce.technician_daily_checkins (service_date, locality_id) WHERE available;

CREATE TABLE workforce.technician_presence (
  technician_user_id uuid PRIMARY KEY REFERENCES workforce.technician_profiles(user_id),
  online             boolean NOT NULL,
  changed_at         timestamptz NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('APP','IVR','AGENT','OPS'))
);

-- One-time, consented; no continuous tracking.
CREATE TABLE workforce.technician_location_shares (
  id                 uuid PRIMARY KEY,
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  visit_id           uuid,   -- ref: jobs.visits
  purpose            text NOT NULL CHECK (purpose IN ('ARRIVAL_SNAPSHOT','SHARE_ONCE_FOR_MATCHING')),
  point_enc          bytea NOT NULL,
  accuracy_m         int CHECK (accuracy_m >= 0),
  mock_location_flag boolean,
  consent_event_id   uuid NOT NULL,   -- ref: compliance.consent_events
  captured_at        timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  CHECK (expires_at > captured_at AND expires_at <= captured_at + interval '30 days')
);

-- Restricted. INV-26: step-up, penny-drop name match, cooling-off before activation (enforced by workforce commands).
CREATE TABLE workforce.payout_methods (
  id                    uuid PRIMARY KEY,
  technician_user_id    uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  type                  text NOT NULL CHECK (type IN ('BANK_ACCOUNT','UPI_VPA')),
  account_number_enc    bytea,
  account_bidx          bytea,
  ifsc                  text CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  vpa_enc               bytea,
  vpa_bidx              bytea,
  holder_name_enc       bytea NOT NULL,
  account_last4         text NOT NULL CHECK (account_last4 ~ '^[0-9A-Za-z]{1,4}$'),
  verification_status   text NOT NULL CHECK (verification_status IN ('PENDING','VERIFIED','FAILED')),
  name_match_score      smallint CHECK (name_match_score BETWEEN 0 AND 100),
  status                text NOT NULL CHECK (status IN ('PENDING_COOLING_OFF','ACTIVE','REPLACED','DISABLED')),
  cooling_off_until     timestamptz NOT NULL,
  created_via           text NOT NULL CHECK (created_via IN ('APP_STEP_UP','AGENT_ASSISTED','OPS_VERIFIED')),
  created_by_actor_type text NOT NULL,
  created_by_actor_id   uuid NOT NULL,
  approval_request_id   uuid,   -- ref: backoffice.approval_requests (maker-checker when created via AGENT/OPS)
  activated_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 0,
  CHECK ((type = 'BANK_ACCOUNT' AND account_number_enc IS NOT NULL AND ifsc IS NOT NULL)
      OR (type = 'UPI_VPA' AND vpa_enc IS NOT NULL)),
  CHECK (status <> 'ACTIVE' OR (verification_status = 'VERIFIED' AND activated_at IS NOT NULL AND activated_at >= cooling_off_until)),
  CHECK (created_via = 'APP_STEP_UP' OR approval_request_id IS NOT NULL)
);
CREATE UNIQUE INDEX payout_active_uq ON workforce.payout_methods (technician_user_id) WHERE status = 'ACTIVE';
CREATE INDEX payout_dedupe_acct_ix ON workforce.payout_methods (account_bidx) WHERE account_bidx IS NOT NULL;
CREATE INDEX payout_dedupe_vpa_ix ON workforce.payout_methods (vpa_bidx) WHERE vpa_bidx IS NOT NULL;

CREATE TABLE workforce.field_agents (
  user_id         uuid PRIMARY KEY,   -- ref: identity.users
  agent_code      text NOT NULL UNIQUE,
  city_id         uuid NOT NULL,      -- ref: geo.cities
  status          text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  contract_ref    text,
  mfa_enrolled_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 0
);

CREATE TABLE workforce.agent_technician_links (
  id                 uuid PRIMARY KEY,
  agent_user_id      uuid NOT NULL REFERENCES workforce.field_agents(user_id),
  technician_user_id uuid NOT NULL REFERENCES workforce.technician_profiles(user_id),
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,
  created_by_admin_id uuid NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX agent_link_active_uq ON workforce.agent_technician_links (technician_user_id) WHERE valid_to IS NULL;

SELECT platform.track_updates('workforce.technician_profiles');
SELECT platform.track_updates('workforce.technician_skills');
SELECT platform.track_updates('workforce.payout_methods');
SELECT platform.make_append_only('workforce.technician_daily_checkins');

SELECT platform.classify('workforce.technician_profiles', 'I',
  'legal_name_enc', 'C,enc', 'display_name', 'P', 'photo_file_id', 'P', 'languages', 'P', 'experience_years', 'P',
  'birth_year', 'C', 'worker_attributes_enc', 'R,enc');
SELECT platform.classify('workforce.technician_skills', 'I');
SELECT platform.classify('workforce.technician_service_areas', 'I');
SELECT platform.classify('workforce.technician_weekly_availability', 'I');
SELECT platform.classify('workforce.technician_availability_overrides', 'I');
SELECT platform.classify('workforce.technician_daily_checkins', 'I');
SELECT platform.classify('workforce.technician_presence', 'I');
SELECT platform.classify('workforce.technician_location_shares', 'I', 'point_enc', 'C,enc');
SELECT platform.classify('workforce.payout_methods', 'R',
  'id', 'I', 'technician_user_id', 'I', 'type', 'I', 'account_number_enc', 'R,enc', 'account_bidx', 'R,bidx',
  'vpa_enc', 'R,enc', 'vpa_bidx', 'R,bidx', 'holder_name_enc', 'R,enc', 'account_last4', 'I',
  'verification_status', 'I', 'status', 'I', 'cooling_off_until', 'I', 'created_via', 'I',
  'created_by_actor_type', 'I', 'created_by_actor_id', 'I', 'approval_request_id', 'I', 'activated_at', 'I',
  'created_at', 'I', 'updated_at', 'I', 'version', 'I');
SELECT platform.classify('workforce.field_agents', 'I', 'contract_ref', 'C');
SELECT platform.classify('workforce.agent_technician_links', 'I');

SELECT platform.register_encrypted('workforce.technician_profiles', 'legal_name_enc', 'TECHNICIAN', 'user_id', 'ANONYMISE_WITH_RECORD');
SELECT platform.register_encrypted('workforce.technician_profiles', 'worker_attributes_enc', 'TECHNICIAN', 'user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('workforce.technician_location_shares', 'point_enc', 'TECHNICIAN', 'technician_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('workforce.payout_methods', 'account_number_enc', 'TECHNICIAN', 'technician_user_id', 'RETAIN_AS_EVIDENCE');
SELECT platform.register_encrypted('workforce.payout_methods', 'vpa_enc', 'TECHNICIAN', 'technician_user_id', 'RETAIN_AS_EVIDENCE');
SELECT platform.register_encrypted('workforce.payout_methods', 'holder_name_enc', 'TECHNICIAN', 'technician_user_id', 'RETAIN_AS_EVIDENCE');

GRANT USAGE ON SCHEMA workforce TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT, UPDATE ON workforce.technician_profiles, workforce.technician_skills, workforce.technician_service_areas,
      workforce.technician_weekly_availability, workforce.technician_availability_overrides, workforce.technician_presence,
      workforce.payout_methods TO app_api;
GRANT SELECT, INSERT ON workforce.technician_daily_checkins, workforce.technician_location_shares TO app_api;
GRANT SELECT ON workforce.field_agents, workforce.agent_technician_links TO app_api;
GRANT SELECT, INSERT, UPDATE ON workforce.technician_profiles, workforce.technician_skills, workforce.technician_service_areas,
      workforce.technician_weekly_availability, workforce.technician_availability_overrides, workforce.technician_presence,
      workforce.payout_methods, workforce.field_agents, workforce.agent_technician_links TO app_admin;
GRANT SELECT, INSERT ON workforce.technician_daily_checkins TO app_admin;
GRANT SELECT ON workforce.technician_location_shares TO app_admin;
GRANT SELECT ON workforce.technician_profiles TO app_voice;
GRANT INSERT ON workforce.technician_daily_checkins TO app_voice;
GRANT SELECT, INSERT, UPDATE ON workforce.technician_presence TO app_voice;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.technician_profiles, workforce.technician_skills, workforce.technician_service_areas,
      workforce.technician_weekly_availability, workforce.technician_availability_overrides, workforce.technician_presence,
      workforce.technician_location_shares, workforce.payout_methods, workforce.field_agents, workforce.agent_technician_links TO app_worker;
GRANT SELECT, INSERT ON workforce.technician_daily_checkins TO app_worker;
