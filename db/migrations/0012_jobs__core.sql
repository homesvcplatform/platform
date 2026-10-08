-- jobs: one job -> many visits -> many assignments; repair orders; append-only histories and presence proofs.
-- Phase 1 03 §9; INV-01 (<= 1 ACTIVE assignment per visit), INV-18 (histories); errata X-24 (payment_preference),
-- X-34 (onsite_adult). Status transition tables + guard triggers arrive with the state machines at Gate 5.
-- Note: the Phase 1 column `window` is a reserved word in PostgreSQL, so it is named `service_window` here.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA jobs;

CREATE TABLE jobs.jobs (
  id                     uuid PRIMARY KEY,
  public_ref             text NOT NULL UNIQUE CHECK (public_ref ~ '^J-[0-9A-HJKMNP-TV-Z]{7}$'),
  customer_user_id       uuid NOT NULL,   -- ref: identity.users
  city_id                uuid NOT NULL,   -- ref: geo.cities
  zone_id                uuid NOT NULL,   -- ref: geo.zones
  locality_id            uuid NOT NULL,   -- ref: geo.localities
  service_type_id        uuid NOT NULL,   -- ref: catalog.service_types
  symptom_codes          text[] NOT NULL DEFAULT '{}',
  problem_text_enc       bytea,
  problem_voice_file_id  uuid,            -- ref: files.file_objects
  problem_photo_file_ids uuid[] NOT NULL DEFAULT '{}',
  address_id             uuid NOT NULL,   -- ref: customers.addresses
  address_snapshot_enc   bytea NOT NULL,
  channel                text NOT NULL CHECK (channel IN ('PWA','OPS_DESK','IVR','WHATSAPP')),
  payment_preference     text NOT NULL CHECK (payment_preference IN ('ONLINE','CASH','EITHER')),        -- X-24
  onsite_adult           text NOT NULL CHECK (onsite_adult IN ('SELF','ADULT_FAMILY','OTHER_ADULT')),   -- X-34
  onsite_contact_enc     bytea,
  created_by_actor_type  text NOT NULL CHECK (created_by_actor_type IN ('CUSTOMER','FIELD_AGENT','ADMIN','SYSTEM')),
  created_by_actor_id    uuid NOT NULL,
  customer_verified      boolean NOT NULL,
  client_request_id      uuid NOT NULL,
  status                 text NOT NULL CHECK (status IN ('REQUESTED','IN_DIAGNOSIS','AWAITING_APPROVAL','REPAIR_PENDING',
                                                         'REPAIR_IN_PROGRESS','AWAITING_PAYMENT','CLOSED','CANCELLED')),
  close_reason           text CHECK (close_reason IN ('REPAIRED','NO_REPAIR_NEEDED','QUOTE_REJECTED','QUOTE_EXPIRED','WARRANTY_RESOLVED')),
  needs_attention        boolean NOT NULL DEFAULT false,
  has_open_complaint     boolean NOT NULL DEFAULT false,
  has_open_dispute       boolean NOT NULL DEFAULT false,
  safety_hold            boolean NOT NULL DEFAULT false,
  warranty_parent_job_id uuid REFERENCES jobs.jobs(id),
  warranty_claim_id      uuid,            -- ref: warranty.warranty_claims
  visit_fee_snapshot_id  uuid NOT NULL,   -- ref: pricing.price_snapshots
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz,
  version                int NOT NULL DEFAULT 0,
  UNIQUE (customer_user_id, client_request_id),   -- idempotent booking at business level
  CHECK ((status = 'CLOSED') = (close_reason IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK ((warranty_parent_job_id IS NULL) = (warranty_claim_id IS NULL))
);
CREATE INDEX jobs_customer_ix ON jobs.jobs (customer_user_id, created_at DESC);
CREATE INDEX jobs_board_ix ON jobs.jobs (city_id, status, created_at) WHERE status NOT IN ('CLOSED','CANCELLED');
CREATE INDEX jobs_dup_check_ix ON jobs.jobs (customer_user_id, address_id, service_type_id)
  WHERE status IN ('REQUESTED','IN_DIAGNOSIS','AWAITING_APPROVAL','REPAIR_PENDING','REPAIR_IN_PROGRESS');

CREATE TABLE jobs.repair_orders (
  id                           uuid PRIMARY KEY,
  job_id                       uuid NOT NULL REFERENCES jobs.jobs(id),
  quote_id                     uuid NOT NULL,   -- ref: diagnosis.quotes
  quote_version_id             uuid NOT NULL,   -- ref: diagnosis.quote_versions (current approved)
  required_service_type_id     uuid NOT NULL,
  required_specialization_id   uuid,
  performer_preference         text NOT NULL CHECK (performer_preference IN ('SAME_VISIT','SAME_TECHNICIAN','RECOMMENDED_SPECIALIST')),
  preferred_technician_user_id uuid,
  allow_fallback               boolean NOT NULL,
  preferred_window             tstzrange,
  materials_required           jsonb NOT NULL,
  materials_supplied_by        text NOT NULL CHECK (materials_supplied_by IN ('TECHNICIAN','CUSTOMER','MIXED','NONE')),
  materials_confirmed_at       timestamptz,
  status                       text NOT NULL CHECK (status IN ('AWAITING_SCHEDULE','SCHEDULED','IN_PROGRESS','CHANGE_PENDING','BLOCKED','COMPLETED','CANCELLED')),
  blocked_reason_code          text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  completed_at                 timestamptz,
  version                      int NOT NULL DEFAULT 0,
  CHECK (performer_preference <> 'SAME_TECHNICIAN' OR preferred_technician_user_id IS NOT NULL),
  CHECK (status <> 'BLOCKED' OR blocked_reason_code IS NOT NULL),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX repair_order_open_uq ON jobs.repair_orders (job_id) WHERE status NOT IN ('COMPLETED','CANCELLED');

CREATE TABLE jobs.visits (
  id                         uuid PRIMARY KEY,
  job_id                     uuid NOT NULL REFERENCES jobs.jobs(id),
  city_id                    uuid NOT NULL,
  locality_id                uuid NOT NULL,
  sequence_no                smallint NOT NULL CHECK (sequence_no >= 1),
  purposes                   text[] NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 2
                                                    AND purposes <@ ARRAY['DIAGNOSIS','REPAIR','WARRANTY_INSPECTION']),
  repair_order_id            uuid REFERENCES jobs.repair_orders(id),
  required_service_type_id   uuid NOT NULL,
  required_specialization_id uuid,
  required_capability        text NOT NULL CHECK (required_capability IN ('DIAGNOSE','REPAIR','DIAGNOSE_AND_REPAIR')),
  service_window             tstzrange NOT NULL CHECK (NOT isempty(service_window)),
  urgency                    text NOT NULL CHECK (urgency IN ('ASAP','SCHEDULED')),
  status                     text NOT NULL CHECK (status IN ('PLANNED','MATCHING','ASSIGNED','EN_ROUTE','ON_SITE','IN_PROGRESS',
                                                             'COMPLETED','CANCELLED','UNFULFILLED','CUSTOMER_NO_SHOW','ABORTED')),
  start_code_hash            bytea NOT NULL,
  start_code_attempts        smallint NOT NULL DEFAULT 0 CHECK (start_code_attempts BETWEEN 0 AND 10),
  completion_code_hash       bytea,
  completion_code_attempts   smallint NOT NULL DEFAULT 0 CHECK (completion_code_attempts BETWEEN 0 AND 10),
  visit_code                 text NOT NULL CHECK (visit_code ~ '^[0-9]{4}$'),
  departed_at                timestamptz,
  arrived_at                 timestamptz,
  work_started_at            timestamptz,
  completed_at               timestamptz,
  terminal_reason_code       text,
  disclosure_opens_at        timestamptz,
  disclosure_closes_at       timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  version                    int NOT NULL DEFAULT 0,
  UNIQUE (job_id, sequence_no),
  CHECK (('REPAIR' = ANY (purposes)) = (repair_order_id IS NOT NULL)),
  CHECK (('REPAIR' = ANY (purposes)) = (completion_code_hash IS NOT NULL)),
  CHECK (status NOT IN ('ON_SITE','IN_PROGRESS','COMPLETED') OR arrived_at IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (disclosure_closes_at IS NULL OR disclosure_opens_at IS NULL OR disclosure_closes_at > disclosure_opens_at)
);
CREATE INDEX visits_job_ix ON jobs.visits (job_id);
CREATE INDEX visits_ops_ix ON jobs.visits (city_id, status, lower(service_window))
  WHERE status NOT IN ('COMPLETED','CANCELLED','CUSTOMER_NO_SHOW','ABORTED');
CREATE INDEX visits_repair_order_ix ON jobs.visits (repair_order_id) WHERE repair_order_id IS NOT NULL;

CREATE TABLE jobs.assignments (
  id                     uuid PRIMARY KEY,
  visit_id               uuid NOT NULL REFERENCES jobs.visits(id),
  technician_user_id     uuid NOT NULL,   -- ref: workforce.technician_profiles
  offer_id               uuid,            -- ref: matching.offers (NULL for manual)
  assigned_via           text NOT NULL CHECK (assigned_via IN ('CASCADE_OFFER','DIRECT_OFFER','MANUAL_OPS')),
  assigned_by_actor_type text NOT NULL,
  assigned_by_actor_id   uuid NOT NULL,
  manual_reason_code     text,
  status                 text NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','RELEASED','NO_SHOW','REVOKED')),
  release_reason_code    text,
  released_by_actor_type text,
  released_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  CHECK (assigned_via <> 'MANUAL_OPS' OR manual_reason_code IS NOT NULL),
  CHECK (assigned_via = 'MANUAL_OPS' OR offer_id IS NOT NULL),
  CHECK ((status = 'ACTIVE') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX assignment_active_uq ON jobs.assignments (visit_id) WHERE status = 'ACTIVE';   -- INV-01
CREATE INDEX assignment_tech_ix ON jobs.assignments (technician_user_id, status, created_at DESC);

-- Histories (INV-18): append-only, partitioned monthly.
CREATE TABLE jobs.job_status_history (
  id             uuid NOT NULL,
  job_id         uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id       uuid,
  channel        text NOT NULL,
  reason_code    text,
  correlation_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX jsh_job_ix ON jobs.job_status_history (job_id, created_at);

CREATE TABLE jobs.visit_status_history (
  id             uuid NOT NULL,
  visit_id       uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id       uuid,
  channel        text NOT NULL,
  reason_code    text,
  correlation_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX vsh_visit_ix ON jobs.visit_status_history (visit_id, created_at);

CREATE TABLE jobs.repair_order_status_history (
  id              uuid NOT NULL,
  repair_order_id uuid NOT NULL,
  from_status     text,
  to_status       text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id        uuid,
  channel         text NOT NULL,
  reason_code     text,
  correlation_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX rosh_ro_ix ON jobs.repair_order_status_history (repair_order_id, created_at);

SELECT platform.ensure_monthly_partitions('jobs.job_status_history', 1, 3);
SELECT platform.ensure_monthly_partitions('jobs.visit_status_history', 1, 3);
SELECT platform.ensure_monthly_partitions('jobs.repair_order_status_history', 1, 3);

CREATE TABLE jobs.visit_presence_proofs (
  id                  uuid PRIMARY KEY,
  visit_id            uuid NOT NULL REFERENCES jobs.visits(id),
  kind                text NOT NULL CHECK (kind IN ('START_CODE','COMPLETION_CODE','OPS_OVERRIDE_ARRIVAL','OPS_OVERRIDE_COMPLETION',
                                                    'LOCATION_SNAPSHOT','CALL_EVIDENCE','CUSTOMER_IDENTITY_CONFIRMED')),
  channel             text NOT NULL CHECK (channel IN ('APP','IVR','OPS','CUSTOMER_APP')),
  actor_type          text NOT NULL,
  actor_id            uuid,
  call_session_id     uuid,
  location_share_id   uuid,
  approval_request_id uuid,
  reason_code         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT LIKE 'OPS\_OVERRIDE%' OR (approval_request_id IS NOT NULL AND reason_code IS NOT NULL))   -- INV-14/15 overrides are audited
);
CREATE INDEX presence_visit_ix ON jobs.visit_presence_proofs (visit_id);

CREATE TABLE jobs.visit_waits (
  id               uuid PRIMARY KEY,
  visit_id         uuid NOT NULL REFERENCES jobs.visits(id),
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  start_evidence   text NOT NULL CHECK (start_evidence IN ('CALL_ATTEMPTS','LOCATION_SNAPSHOT','OPS_CONFIRMED','CUSTOMER_ACK')),
  outcome          text CHECK (outcome IN ('CUSTOMER_ARRIVED','CUSTOMER_NO_SHOW','CANCELLED')),
  billable_minutes int CHECK (billable_minutes >= 0),
  fee_paise        bigint CHECK (fee_paise >= 0),
  CHECK ((ended_at IS NULL) = (outcome IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX visit_wait_open_uq ON jobs.visit_waits (visit_id) WHERE ended_at IS NULL;

CREATE TABLE jobs.job_cancellations (
  job_id                        uuid PRIMARY KEY REFERENCES jobs.jobs(id),
  visit_id                      uuid,
  cancelled_by_actor_type       text NOT NULL,
  cancelled_by_actor_id         uuid,
  reason_code                   text NOT NULL,
  stage                         text NOT NULL,
  customer_fee_paise            bigint NOT NULL DEFAULT 0 CHECK (customer_fee_paise >= 0),
  technician_compensation_paise bigint NOT NULL DEFAULT 0 CHECK (technician_compensation_paise >= 0),
  price_snapshot_id             uuid NOT NULL,   -- ref: pricing.price_snapshots
  created_at                    timestamptz NOT NULL DEFAULT now()
);

SELECT platform.track_updates('jobs.jobs');
SELECT platform.track_updates('jobs.repair_orders');
SELECT platform.track_updates('jobs.visits');
SELECT platform.make_append_only('jobs.job_status_history');
SELECT platform.make_append_only('jobs.visit_status_history');
SELECT platform.make_append_only('jobs.repair_order_status_history');
SELECT platform.make_append_only('jobs.visit_presence_proofs');
SELECT platform.make_append_only('jobs.job_cancellations');

SELECT platform.classify('jobs.jobs', 'I', 'problem_text_enc', 'C,enc', 'address_snapshot_enc', 'C,enc', 'onsite_contact_enc', 'C,enc');
SELECT platform.classify('jobs.repair_orders', 'I');
SELECT platform.classify('jobs.visits', 'I', 'start_code_hash', 'R', 'completion_code_hash', 'R');
SELECT platform.classify('jobs.assignments', 'I');
SELECT platform.classify('jobs.job_status_history', 'I');
SELECT platform.classify('jobs.visit_status_history', 'I');
SELECT platform.classify('jobs.repair_order_status_history', 'I');
SELECT platform.classify('jobs.visit_presence_proofs', 'I');
SELECT platform.classify('jobs.visit_waits', 'I');
SELECT platform.classify('jobs.job_cancellations', 'I');

SELECT platform.register_encrypted('jobs.jobs', 'problem_text_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('jobs.jobs', 'address_snapshot_enc', 'CUSTOMER', 'customer_user_id', 'ANONYMISE_WITH_RECORD');
SELECT platform.register_encrypted('jobs.jobs', 'onsite_contact_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');

INSERT INTO platform.archive_policies (table_schema, table_name, hot_retention, archive_mode, legal_basis) VALUES
  ('jobs', 'job_status_history', interval '3 years', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: jobs/visits close + 3 y, then anonymise'),
  ('jobs', 'visit_status_history', interval '3 years', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: jobs/visits close + 3 y, then anonymise'),
  ('jobs', 'repair_order_status_history', interval '3 years', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: jobs/visits close + 3 y, then anonymise');

GRANT USAGE ON SCHEMA jobs TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT, UPDATE ON jobs.jobs, jobs.repair_orders, jobs.visits, jobs.assignments, jobs.visit_waits TO app_api, app_admin;
GRANT SELECT, INSERT ON jobs.job_status_history, jobs.visit_status_history, jobs.repair_order_status_history,
      jobs.visit_presence_proofs, jobs.job_cancellations TO app_api, app_admin;
-- voice: the IVR commands (offer accept, depart, arrive, complete) - 03 §12.1.
GRANT SELECT, UPDATE ON jobs.jobs, jobs.repair_orders, jobs.visits TO app_voice;
GRANT SELECT, INSERT, UPDATE ON jobs.assignments, jobs.visit_waits TO app_voice;
GRANT INSERT ON jobs.job_status_history, jobs.visit_status_history, jobs.repair_order_status_history, jobs.visit_presence_proofs TO app_voice;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs.jobs, jobs.repair_orders, jobs.visits, jobs.assignments, jobs.visit_waits TO app_worker;
GRANT SELECT, INSERT ON jobs.job_status_history, jobs.visit_status_history, jobs.repair_order_status_history,
      jobs.visit_presence_proofs, jobs.job_cancellations TO app_worker;
