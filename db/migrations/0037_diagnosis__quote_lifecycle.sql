-- diagnosis (Gate 6, ADR-027): quote-version history (INV-18 names QuoteVersion) and the D11 tightening of the quote
-- version state machine to Phase 1 06 §7: a version is SUPERSEDED only after it was APPROVED (a later version approved
-- as a change order); a PRESENTED version that is replaced before a decision is WITHDRAWN. The history row is written by
-- a trigger from the transaction-local actor context (`hsp.actor_*`, as jobs does in 0033), so no status change can skip
-- its history row (HS031).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- A draft's lines while it is edited (04 §10 PUT replaces the draft). Runtime roles can't delete diagnosis_items (only
-- the worker may DELETE), so the lines are kept here and written to diagnosis_items once, at submission; the column is
-- cleared then, and both are immutable afterwards (guard_diagnosis / guard_diagnosis_item).
ALTER TABLE diagnosis.diagnoses ADD COLUMN draft_lines jsonb;

CREATE OR REPLACE FUNCTION diagnosis.guard_quote_version() RETURNS trigger
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
         OR (OLD.status = 'PRESENTED' AND NEW.status IN ('APPROVED','REJECTED','EXPIRED','WITHDRAWN'))
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

CREATE TABLE diagnosis.quote_version_status_history (
  id               uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  from_status      text,
  to_status        text NOT NULL,
  actor_type       text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id         uuid,
  channel          text NOT NULL,
  reason_code      text,
  correlation_id   uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX qvsh_version_ix ON diagnosis.quote_version_status_history (quote_version_id, created_at);
SELECT platform.ensure_monthly_partitions('diagnosis.quote_version_status_history', 1, 3);
SELECT platform.make_append_only('diagnosis.quote_version_status_history');

CREATE FUNCTION diagnosis.record_quote_version_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_actor_type text := nullif(current_setting('hsp.actor_type', true), '');
  v_actor_id   text := nullif(current_setting('hsp.actor_id', true), '');
  v_channel    text := nullif(current_setting('hsp.channel', true), '');
  v_corr       text := nullif(current_setting('hsp.correlation_id', true), '');
  v_reason     text := nullif(current_setting('hsp.reason_code', true), '');
  v_from       text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  IF v_actor_type IS NULL OR v_channel IS NULL OR v_corr IS NULL THEN
    RAISE EXCEPTION 'status change of quote version without actor context' USING ERRCODE = 'HS031';
  END IF;
  INSERT INTO diagnosis.quote_version_status_history (id, quote_version_id, from_status, to_status, actor_type, actor_id, channel, reason_code, correlation_id)
  VALUES (gen_random_uuid(), NEW.id, v_from, NEW.status, v_actor_type, v_actor_id::uuid, v_channel, v_reason, v_corr::uuid);
  RETURN NULL;
END $$;

CREATE TRIGGER record_transition AFTER INSERT OR UPDATE OF status ON diagnosis.quote_versions
  FOR EACH ROW EXECUTE FUNCTION diagnosis.record_quote_version_transition();
REVOKE ALL ON FUNCTION diagnosis.record_quote_version_transition() FROM PUBLIC;

SELECT platform.classify('diagnosis.quote_version_status_history', 'I');
INSERT INTO platform.archive_policies (table_schema, table_name, hot_retention, archive_mode, legal_basis) VALUES
  ('diagnosis', 'quote_version_status_history', interval '3 years', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: jobs/visits close + 3 y, then anonymise');

GRANT SELECT, INSERT ON diagnosis.quote_version_status_history TO app_api, app_admin, app_worker;
