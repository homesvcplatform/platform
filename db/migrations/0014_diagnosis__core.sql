-- diagnosis: diagnoses (immutable once submitted), immutable quote versions + items, one decision per version.
-- Phase 1 03 §11; INV-05 (version immutable once PRESENTED), INV-06 (approve only the presented version with its
-- content hash), INV-07 (<= 1 APPROVED version per quote); errata G-8 (VISIT_FEE_CREDIT), G-9 (separation of duties).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA diagnosis;

CREATE TABLE diagnosis.diagnoses (
  id                                uuid PRIMARY KEY,
  job_id                            uuid NOT NULL,   -- ref: jobs.jobs
  visit_id                          uuid NOT NULL,   -- ref: jobs.visits
  technician_user_id                uuid NOT NULL,
  captured_by_actor_type            text NOT NULL CHECK (captured_by_actor_type IN ('TECHNICIAN','OPS_AGENT')),
  captured_by_actor_id              uuid NOT NULL,
  kind                              text NOT NULL CHECK (kind IN ('INITIAL','ADDITIONAL_FINDING','WARRANTY_ASSESSMENT')),
  problem_code                      text NOT NULL,
  observed_chips                    text[] NOT NULL DEFAULT '{}',
  observed_notes_enc                bytea,
  severity                          text NOT NULL CHECK (severity IN ('MINOR','MODERATE','MAJOR','SAFETY_HAZARD')),
  safety_advice_code                text,
  required_repair_service_type_id   uuid,
  required_repair_specialization_id uuid,
  no_repair_needed                  boolean NOT NULL DEFAULT false,
  same_visit_feasible               boolean NOT NULL,
  material_available_now            boolean NOT NULL,
  warranty_assessment               text CHECK (warranty_assessment IN ('COVERED','NOT_COVERED','PARTIAL')),
  status                            text NOT NULL CHECK (status IN ('DRAFT','SUBMITTED','SUPERSEDED','VOIDED')),
  supersedes_id                     uuid REFERENCES diagnosis.diagnoses(id),
  submitted_at                      timestamptz,
  voided_reason_code                text,
  voided_by_admin_id                uuid,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  version                           int NOT NULL DEFAULT 0,
  CHECK (severity <> 'SAFETY_HAZARD' OR safety_advice_code IS NOT NULL),
  CHECK (no_repair_needed OR required_repair_service_type_id IS NOT NULL OR status = 'DRAFT'),
  CHECK (kind <> 'WARRANTY_ASSESSMENT' OR warranty_assessment IS NOT NULL OR status = 'DRAFT'),
  CHECK (status NOT IN ('SUBMITTED','SUPERSEDED') OR submitted_at IS NOT NULL),
  CHECK (status <> 'VOIDED' OR voided_reason_code IS NOT NULL)
);
CREATE INDEX diag_job_ix ON diagnosis.diagnoses (job_id);

CREATE TABLE diagnosis.diagnosis_items (
  id                        uuid PRIMARY KEY,
  diagnosis_id              uuid NOT NULL REFERENCES diagnosis.diagnoses(id),
  line_type                 text NOT NULL CHECK (line_type IN ('REPAIR_ITEM','MATERIAL','CUSTOM_LABOUR')),
  repair_item_id            uuid,   -- ref: catalog.repair_items
  material_id               uuid,   -- ref: catalog.materials
  qty                       numeric(10,3) NOT NULL CHECK (qty > 0),
  proposed_unit_price_paise bigint CHECK (proposed_unit_price_paise >= 0),
  reason_code               text,
  notes                     text CHECK (char_length(notes) <= 500),
  CHECK ((line_type = 'REPAIR_ITEM') = (repair_item_id IS NOT NULL)),
  CHECK ((line_type = 'MATERIAL') = (material_id IS NOT NULL)),
  CHECK (line_type <> 'CUSTOM_LABOUR' OR reason_code IS NOT NULL)
);
CREATE INDEX diag_items_diag_ix ON diagnosis.diagnosis_items (diagnosis_id);

CREATE TABLE diagnosis.diagnosis_media (
  id              uuid PRIMARY KEY,
  diagnosis_id    uuid NOT NULL REFERENCES diagnosis.diagnoses(id),
  file_id         uuid NOT NULL,   -- ref: files.file_objects
  kind            text NOT NULL CHECK (kind IN ('PHOTO_BEFORE','PHOTO_AFTER','VOICE_NOTE')),
  captured_in_app boolean NOT NULL,
  perceptual_hash bytea,
  captured_at     timestamptz NOT NULL
);
CREATE INDEX diag_media_diag_ix ON diagnosis.diagnosis_media (diagnosis_id);

CREATE TABLE diagnosis.quotes (
  id                  uuid PRIMARY KEY,
  job_id              uuid NOT NULL UNIQUE,   -- ref: jobs.jobs
  latest_version_no   smallint NOT NULL DEFAULT 0 CHECK (latest_version_no >= 0),
  approved_version_id uuid,                   -- convenience pointer, maintained in the same transaction
  created_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 0
);

CREATE TABLE diagnosis.quote_versions (
  id                        uuid PRIMARY KEY,
  quote_id                  uuid NOT NULL REFERENCES diagnosis.quotes(id),
  version_no                smallint NOT NULL CHECK (version_no >= 1),
  diagnosis_ids             uuid[] NOT NULL CHECK (cardinality(diagnosis_ids) >= 1),
  created_by_actor_type     text NOT NULL,
  created_by_actor_id       uuid NOT NULL,
  price_snapshot_id         uuid NOT NULL,   -- ref: pricing.price_snapshots
  currency                  char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  items_total_paise         bigint NOT NULL CHECK (items_total_paise >= 0),
  discount_paise            bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  visit_fee_credit_paise    bigint NOT NULL DEFAULT 0 CHECK (visit_fee_credit_paise >= 0),
  tax_paise                 bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_payable_paise       bigint NOT NULL CHECK (total_payable_paise >= 0),
  technician_earnings_paise bigint NOT NULL CHECK (technician_earnings_paise >= 0),
  content_hash              bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  status                    text NOT NULL CHECK (status IN ('DRAFT','PRESENTED','APPROVED','REJECTED','EXPIRED','WITHDRAWN','SUPERSEDED')),
  presented_at              timestamptz,
  expires_at                timestamptz,
  decided_at                timestamptz,
  supersedes_version_id     uuid REFERENCES diagnosis.quote_versions(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_no),
  CHECK (total_payable_paise = items_total_paise - discount_paise - visit_fee_credit_paise + tax_paise),
  CHECK (status = 'DRAFT' OR presented_at IS NOT NULL OR status = 'WITHDRAWN'),
  CHECK (status NOT IN ('APPROVED','REJECTED') OR decided_at IS NOT NULL)
);
CREATE UNIQUE INDEX qv_one_presented_uq ON diagnosis.quote_versions (quote_id) WHERE status = 'PRESENTED';
CREATE UNIQUE INDEX qv_one_approved_uq ON diagnosis.quote_versions (quote_id) WHERE status = 'APPROVED';   -- INV-07

CREATE TABLE diagnosis.quote_items (
  id                         uuid PRIMARY KEY,
  quote_version_id           uuid NOT NULL REFERENCES diagnosis.quote_versions(id),
  line_no                    smallint NOT NULL CHECK (line_no >= 1),
  item_type                  text NOT NULL CHECK (item_type IN ('VISIT_FEE','VISIT_FEE_CREDIT','LABOUR','MATERIAL','PLATFORM_FEE','DISCOUNT','TAX')),
  repair_item_id             uuid,   -- ref: catalog.repair_items
  material_id                uuid,   -- ref: catalog.materials
  label_key                  text NOT NULL,
  label_params               jsonb NOT NULL DEFAULT '{}',
  qty                        numeric(10,3) NOT NULL CHECK (qty > 0),
  unit_price_paise           bigint NOT NULL CHECK (unit_price_paise >= 0),
  amount_paise               bigint NOT NULL CHECK (amount_paise >= 0),   -- G-8: credit types are subtracted, amounts stay >= 0
  reference_unit_price_paise bigint CHECK (reference_unit_price_paise >= 0),
  deviation_bps              int,
  deviation_reason_code      text,
  tax_rate_bps               int NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 5000),
  technician_share_paise     bigint NOT NULL DEFAULT 0 CHECK (technician_share_paise >= 0),
  UNIQUE (quote_version_id, line_no),
  CHECK (amount_paise = round(qty * unit_price_paise)),
  CHECK (deviation_bps IS NULL OR abs(deviation_bps) <= 2000 OR deviation_reason_code IS NOT NULL),
  CHECK (item_type <> 'MATERIAL' OR material_id IS NOT NULL)
);

-- One decision per version; append-only.
CREATE TABLE diagnosis.quote_approvals (
  id                           uuid PRIMARY KEY,
  quote_version_id             uuid NOT NULL UNIQUE REFERENCES diagnosis.quote_versions(id),
  decision                     text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  content_hash                 bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  channel                      text NOT NULL CHECK (channel IN ('APP_SESSION','SIGNED_LINK_OTP','IVR_CALL','OPS_RECORDED_CALL')),
  customer_user_id             uuid NOT NULL,
  session_id                   uuid,
  device_id                    uuid,
  otp_challenge_id             uuid,
  call_session_id              uuid,
  ops_recorder_admin_id        uuid,
  ops_verifier_admin_id        uuid,
  diagnosis_capturer_admin_id  uuid,
  repair_preference            text CHECK (repair_preference IN ('SAME_VISIT','SAME_TECHNICIAN','RECOMMENDED_SPECIALIST')),
  preferred_technician_user_id uuid,
  allow_fallback               boolean,
  preferred_window             tstzrange,
  rejection_reason_code        text,
  decided_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (channel <> 'APP_SESSION' OR session_id IS NOT NULL),
  CHECK (channel <> 'SIGNED_LINK_OTP' OR otp_challenge_id IS NOT NULL),
  CHECK (channel <> 'IVR_CALL' OR call_session_id IS NOT NULL),
  CHECK (channel <> 'OPS_RECORDED_CALL' OR (call_session_id IS NOT NULL AND ops_recorder_admin_id IS NOT NULL
                                            AND ops_verifier_admin_id IS NOT NULL AND ops_recorder_admin_id <> ops_verifier_admin_id)),
  CHECK (diagnosis_capturer_admin_id IS NULL OR (diagnosis_capturer_admin_id IS DISTINCT FROM ops_recorder_admin_id
                                                 AND diagnosis_capturer_admin_id IS DISTINCT FROM ops_verifier_admin_id)),   -- G-9
  CHECK (decision <> 'APPROVED' OR repair_preference IS NOT NULL),
  CHECK (decision <> 'REJECTED' OR rejection_reason_code IS NOT NULL),
  CHECK (repair_preference IS DISTINCT FROM 'SAME_TECHNICIAN' OR preferred_technician_user_id IS NOT NULL)
);

CREATE TABLE diagnosis.quote_links (
  id               uuid PRIMARY KEY,
  quote_version_id uuid NOT NULL REFERENCES diagnosis.quote_versions(id),
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE diagnosis.material_usage (
  id                     uuid PRIMARY KEY,
  repair_order_id        uuid NOT NULL,   -- ref: jobs.repair_orders
  visit_id               uuid NOT NULL,   -- ref: jobs.visits
  quote_item_id          uuid NOT NULL REFERENCES diagnosis.quote_items(id),
  material_id            uuid NOT NULL,   -- ref: catalog.materials
  qty_quoted             numeric(10,3) NOT NULL CHECK (qty_quoted > 0),
  qty_used               numeric(10,3) NOT NULL CHECK (qty_used >= 0),
  actual_unit_cost_paise bigint CHECK (actual_unit_cost_paise >= 0),
  receipt_file_id        uuid,
  recorded_by_actor_type text NOT NULL,
  recorded_by_actor_id   uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_used <= qty_quoted),   -- more material => a new quote version
  UNIQUE (quote_item_id, visit_id)
);

-- Guards ------------------------------------------------------------------------------------------------------------

-- A submitted diagnosis is immutable except for its status (SUPERSEDED / VOIDED) and void details.
CREATE FUNCTION diagnosis.guard_diagnosis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  mutable_cols constant text[] := ARRAY['status','voided_reason_code','voided_by_admin_id','updated_at','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'diagnosis % cannot be deleted', OLD.id USING ERRCODE = 'HS002';
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'diagnosis % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'HS002';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED','VOIDED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUPERSEDED','VOIDED'))) THEN
    RAISE EXCEPTION 'diagnosis status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'HS003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_diagnosis BEFORE UPDATE OR DELETE ON diagnosis.diagnoses
  FOR EACH ROW EXECUTE FUNCTION diagnosis.guard_diagnosis();

-- Diagnosis lines may change only while the diagnosis is a DRAFT.
CREATE FUNCTION diagnosis.guard_diagnosis_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parent uuid;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent := OLD.diagnosis_id;
  ELSE
    parent := NEW.diagnosis_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.diagnosis_id <> OLD.diagnosis_id THEN
      RAISE EXCEPTION 'diagnosis items cannot move between diagnoses' USING ERRCODE = 'HS002';
    END IF;
  END IF;
  SELECT d.status INTO parent_status FROM diagnosis.diagnoses d WHERE d.id = parent;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'diagnosis % is %: its items are immutable', parent, parent_status USING ERRCODE = 'HS002';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_diagnosis_item BEFORE INSERT OR UPDATE OR DELETE ON diagnosis.diagnosis_items
  FOR EACH ROW EXECUTE FUNCTION diagnosis.guard_diagnosis_item();

-- INV-05: once a version leaves DRAFT only status / decided_at may change, along the allowed transitions. On
-- DRAFT -> PRESENTED the stored totals must equal the items (G-8: credit lines are subtracted).
CREATE FUNCTION diagnosis.guard_quote_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  mutable_cols constant text[] := ARRAY['status','decided_at'];
  sums record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quote version % cannot be deleted', OLD.id USING ERRCODE = 'HS002';
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'quote version % is % and immutable (INV-05)', OLD.id, OLD.status USING ERRCODE = 'HS002';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PRESENTED','WITHDRAWN'))
         OR (OLD.status = 'PRESENTED' AND NEW.status IN ('APPROVED','REJECTED','EXPIRED','WITHDRAWN','SUPERSEDED'))
         OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'quote version status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'HS003';
    END IF;
    IF NEW.status = 'PRESENTED' THEN
      SELECT count(*) AS n,
             coalesce(sum(i.amount_paise) FILTER (WHERE i.item_type IN ('VISIT_FEE','LABOUR','MATERIAL','PLATFORM_FEE')), 0) AS items_total,
             coalesce(sum(i.amount_paise) FILTER (WHERE i.item_type = 'DISCOUNT'), 0) AS discount,
             coalesce(sum(i.amount_paise) FILTER (WHERE i.item_type = 'VISIT_FEE_CREDIT'), 0) AS credit,
             coalesce(sum(i.amount_paise) FILTER (WHERE i.item_type = 'TAX'), 0) AS tax
        INTO sums
        FROM diagnosis.quote_items i WHERE i.quote_version_id = NEW.id;
      IF sums.n = 0 OR sums.items_total <> NEW.items_total_paise OR sums.discount <> NEW.discount_paise
         OR sums.credit <> NEW.visit_fee_credit_paise OR sums.tax <> NEW.tax_paise THEN
        RAISE EXCEPTION 'quote version % totals do not match its items', NEW.id USING ERRCODE = 'HS020';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_quote_version BEFORE UPDATE OR DELETE ON diagnosis.quote_versions
  FOR EACH ROW EXECUTE FUNCTION diagnosis.guard_quote_version();

-- Quote items are never updated or deleted, and are inserted only while their version is a DRAFT.
CREATE FUNCTION diagnosis.guard_quote_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'quote items are immutable (INV-05): % rejected', TG_OP USING ERRCODE = 'HS002';
  END IF;
  SELECT v.status INTO parent_status FROM diagnosis.quote_versions v WHERE v.id = NEW.quote_version_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'quote version % is %: items can only be added to a DRAFT', NEW.quote_version_id, parent_status USING ERRCODE = 'HS002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_quote_item BEFORE INSERT OR UPDATE OR DELETE ON diagnosis.quote_items
  FOR EACH ROW EXECUTE FUNCTION diagnosis.guard_quote_item();
CREATE TRIGGER guard_quote_item_truncate BEFORE TRUNCATE ON diagnosis.quote_items
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();

-- INV-06: a decision is recorded only for the currently PRESENTED version and must carry the hash the customer saw.
CREATE FUNCTION diagnosis.guard_quote_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v record;
BEGIN
  SELECT status, content_hash INTO v FROM diagnosis.quote_versions WHERE id = NEW.quote_version_id;
  IF v.status IS DISTINCT FROM 'PRESENTED' THEN
    RAISE EXCEPTION 'quote version % is %: only a PRESENTED version can be decided', NEW.quote_version_id, v.status USING ERRCODE = 'HS020';
  END IF;
  IF NEW.content_hash IS DISTINCT FROM v.content_hash THEN
    RAISE EXCEPTION 'approval content hash does not match quote version % (INV-06)', NEW.quote_version_id USING ERRCODE = 'HS020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_quote_approval BEFORE INSERT ON diagnosis.quote_approvals
  FOR EACH ROW EXECUTE FUNCTION diagnosis.guard_quote_approval();

SELECT platform.track_updates('diagnosis.diagnoses');
SELECT platform.make_append_only('diagnosis.quote_approvals');

SELECT platform.classify('diagnosis.diagnoses', 'I', 'observed_notes_enc', 'C,enc');
SELECT platform.classify('diagnosis.diagnosis_items', 'I', 'notes', 'C');
SELECT platform.classify('diagnosis.diagnosis_media', 'I');
SELECT platform.classify('diagnosis.quotes', 'I');
SELECT platform.classify('diagnosis.quote_versions', 'I');
SELECT platform.classify('diagnosis.quote_items', 'I');
SELECT platform.classify('diagnosis.quote_approvals', 'I');
SELECT platform.classify('diagnosis.quote_links', 'I', 'token_hash', 'R');
SELECT platform.classify('diagnosis.material_usage', 'I');

SELECT platform.register_encrypted('diagnosis.diagnoses', 'observed_notes_enc', 'PLATFORM', NULL, 'ANONYMISE_WITH_RECORD',
  'Technician / ops notes about the fault, not about the person; kept with the job (close + 3 y) then anonymised');

GRANT USAGE ON SCHEMA diagnosis TO app_api, app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON diagnosis.diagnoses, diagnosis.diagnosis_items, diagnosis.quotes, diagnosis.quote_versions,
      diagnosis.quote_links, diagnosis.material_usage TO app_api, app_admin;
GRANT SELECT, INSERT ON diagnosis.diagnosis_media, diagnosis.quote_items, diagnosis.quote_approvals TO app_api, app_admin;
GRANT SELECT, INSERT, UPDATE ON diagnosis.diagnoses, diagnosis.quote_versions TO app_worker;   -- never deleted (guards)
GRANT SELECT, INSERT, UPDATE, DELETE ON diagnosis.diagnosis_items, diagnosis.diagnosis_media, diagnosis.quotes,
      diagnosis.quote_links, diagnosis.material_usage TO app_worker;
GRANT SELECT, INSERT ON diagnosis.quote_items, diagnosis.quote_approvals TO app_worker;
