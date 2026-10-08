-- warranty: versioned policies, immutable coverage snapshots (INV-22), claims. Phase 1 03 §13.
-- Slice scope: coverage creation only; claims UI is out of scope (05 §7) but the table exists for the API stubs.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA warranty;

CREATE TABLE warranty.warranty_policies (
  id                  uuid PRIMARY KEY,
  code                text NOT NULL,
  version_no          int NOT NULL CHECK (version_no >= 1),
  scope_type          text NOT NULL CHECK (scope_type IN ('SERVICE_TYPE','REPAIR_ITEM')),
  scope_id            uuid NOT NULL,   -- ref: catalog.service_types / catalog.repair_items
  city_id             uuid,
  duration_days       smallint NOT NULL CHECK (duration_days BETWEEN 0 AND 365),
  revisit_fee_waived  boolean NOT NULL DEFAULT true,
  cost_bearer         text NOT NULL CHECK (cost_bearer IN ('ORIGINAL_TECHNICIAN','PLATFORM','SPLIT')),
  cost_split_bps      int CHECK (cost_split_bps BETWEEN 0 AND 10000),
  exclusions          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(exclusions) = 'array'),
  status              text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED')),
  effective           tstzrange NOT NULL CHECK (NOT isempty(effective)),
  approval_request_id uuid,
  UNIQUE (code, version_no),
  CHECK ((cost_bearer = 'SPLIT') = (cost_split_bps IS NOT NULL))
);

-- Immutable snapshot (INV-22): created when a repair order completes and the job closes; only expiry / voiding change.
CREATE TABLE warranty.warranty_coverages (
  id                           uuid PRIMARY KEY,
  job_id                       uuid NOT NULL UNIQUE,   -- ref: jobs.jobs
  repair_order_id              uuid NOT NULL,          -- ref: jobs.repair_orders
  customer_user_id             uuid NOT NULL,
  policy_id                    uuid NOT NULL REFERENCES warranty.warranty_policies(id),
  policy_snapshot              jsonb NOT NULL,
  covered_repair_item_ids      uuid[] NOT NULL CHECK (cardinality(covered_repair_item_ids) >= 1),
  original_technician_user_ids uuid[] NOT NULL CHECK (cardinality(original_technician_user_ids) >= 1),
  starts_at                    timestamptz NOT NULL,
  ends_at                      timestamptz NOT NULL,
  status                       text NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','VOIDED')),
  voided_reason_code           text,
  CHECK (ends_at >= starts_at),
  CHECK (status <> 'VOIDED' OR voided_reason_code IS NOT NULL)
);
CREATE INDEX coverage_customer_ix ON warranty.warranty_coverages (customer_user_id, ends_at DESC);

CREATE TABLE warranty.warranty_claims (
  id                    uuid PRIMARY KEY,
  coverage_id           uuid NOT NULL REFERENCES warranty.warranty_coverages(id),
  original_job_id       uuid NOT NULL,
  warranty_job_id       uuid,
  customer_user_id      uuid NOT NULL,
  description_enc       bytea,
  media_file_ids        uuid[] NOT NULL DEFAULT '{}',
  status                text NOT NULL CHECK (status IN ('SUBMITTED','AUTO_ELIGIBLE','NEEDS_REVIEW','INELIGIBLE','INSPECTION_SCHEDULED',
                                                        'COVERED','NOT_COVERED','PARTIALLY_COVERED','DISPUTED','CLOSED')),
  decision_reason_code  text,
  decided_by_actor_type text,
  decided_by_actor_id   uuid,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  version               int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX claim_open_uq ON warranty.warranty_claims (coverage_id) WHERE status NOT IN ('INELIGIBLE','CLOSED','NOT_COVERED');

CREATE FUNCTION warranty.guard_coverage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  mutable_cols constant text[] := ARRAY['status','voided_reason_code'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warranty coverage % cannot be deleted', OLD.id USING ERRCODE = 'HS002';
  END IF;
  IF (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'warranty coverage % is an immutable snapshot (INV-22)', OLD.id USING ERRCODE = 'HS002';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('EXPIRED','VOIDED')) THEN
    RAISE EXCEPTION 'warranty coverage status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'HS003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_coverage BEFORE UPDATE OR DELETE ON warranty.warranty_coverages
  FOR EACH ROW EXECUTE FUNCTION warranty.guard_coverage();

SELECT platform.classify('warranty.warranty_policies', 'I');
SELECT platform.classify('warranty.warranty_coverages', 'I');
SELECT platform.classify('warranty.warranty_claims', 'I', 'description_enc', 'C,enc');

SELECT platform.register_encrypted('warranty.warranty_claims', 'description_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');

GRANT USAGE ON SCHEMA warranty TO app_api, app_admin, app_worker;
GRANT SELECT ON warranty.warranty_policies, warranty.warranty_coverages TO app_api;
GRANT SELECT, INSERT ON warranty.warranty_claims TO app_api;
GRANT SELECT, INSERT, UPDATE ON warranty.warranty_policies TO app_admin;
GRANT SELECT ON warranty.warranty_coverages TO app_admin;
GRANT SELECT, UPDATE ON warranty.warranty_claims TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON warranty.warranty_policies, warranty.warranty_claims TO app_worker;
GRANT SELECT, INSERT, UPDATE ON warranty.warranty_coverages TO app_worker;
