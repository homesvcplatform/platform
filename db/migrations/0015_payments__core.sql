-- payments: bills (issued in the completion transaction, TCP-3), immutable bill lines, payment intents, captured
-- payments, cash collections, refunds, chargebacks, invoices, payouts, raw provider events, reconciliation.
-- Phase 1 09 §5; INV-09/10/12/24, errata G-8 (credit line types), X-11 (voice inserts cash collections), G-5 (no ledger
-- writes here: postings are made asynchronously by the worker in the ledger schema, migration 0016).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA payments;

CREATE TABLE payments.bills (
  id                   uuid PRIMARY KEY,
  job_id               uuid NOT NULL,   -- ref: jobs.jobs
  bill_no              smallint NOT NULL CHECK (bill_no >= 1),
  kind                 text NOT NULL CHECK (kind IN ('FINAL','VISIT_FEE','CANCELLATION','NO_SHOW','WAITING','ADJUSTMENT')),
  quote_version_id     uuid,            -- ref: diagnosis.quote_versions
  price_snapshot_id    uuid NOT NULL,   -- ref: pricing.price_snapshots
  amount_due_paise     bigint NOT NULL CHECK (amount_due_paise >= 0),
  amount_settled_paise bigint NOT NULL DEFAULT 0 CHECK (amount_settled_paise >= 0),
  status               text NOT NULL CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','VOID','WRITTEN_OFF')),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  settled_at           timestamptz,
  version              int NOT NULL DEFAULT 0,
  UNIQUE (job_id, bill_no),
  CHECK (amount_settled_paise <= amount_due_paise),
  CHECK (status <> 'PAID' OR (amount_settled_paise = amount_due_paise AND settled_at IS NOT NULL)),
  CHECK (kind <> 'FINAL' OR quote_version_id IS NOT NULL)
);

CREATE TABLE payments.bill_lines (
  id                     uuid PRIMARY KEY,
  bill_id                uuid NOT NULL REFERENCES payments.bills(id),
  line_no                smallint NOT NULL CHECK (line_no >= 1),
  line_type              text NOT NULL CHECK (line_type IN ('VISIT_FEE','VISIT_FEE_CREDIT','LABOUR','MATERIAL','UNUSED_MATERIAL_CREDIT',
                                                            'PLATFORM_FEE','CANCELLATION_FEE','WAITING_FEE','NO_SHOW_FEE','DISCOUNT',
                                                            'TAX','PRIOR_PAYMENT_CREDIT')),
  quote_item_id          uuid,   -- ref: diagnosis.quote_items
  prior_bill_id          uuid REFERENCES payments.bills(id),
  label_key              text NOT NULL,
  label_params           jsonb NOT NULL DEFAULT '{}',
  amount_paise           bigint NOT NULL,   -- signed: credits negative
  technician_user_id     uuid,
  technician_share_paise bigint NOT NULL DEFAULT 0 CHECK (technician_share_paise >= 0),
  UNIQUE (bill_id, line_no),
  -- G-8: credit types are negative, everything else non-negative.
  CHECK (CASE WHEN line_type IN ('VISIT_FEE_CREDIT','UNUSED_MATERIAL_CREDIT','DISCOUNT','PRIOR_PAYMENT_CREDIT')
              THEN amount_paise <= 0 ELSE amount_paise >= 0 END),
  CHECK ((line_type = 'PRIOR_PAYMENT_CREDIT') = (prior_bill_id IS NOT NULL)),
  CHECK (prior_bill_id IS NULL OR prior_bill_id <> bill_id)
);
CREATE INDEX bill_lines_bill_ix ON payments.bill_lines (bill_id);

CREATE TABLE payments.payment_intents (
  id                uuid PRIMARY KEY,
  bill_id           uuid NOT NULL REFERENCES payments.bills(id),
  customer_user_id  uuid NOT NULL,
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  currency          char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  provider          text NOT NULL,
  provider_order_id text NOT NULL,
  status            text NOT NULL CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED','CANCELLED')),
  failure_code      text,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 0,
  UNIQUE (provider, provider_order_id)
);
CREATE UNIQUE INDEX one_live_intent_per_bill ON payments.payment_intents (bill_id) WHERE status IN ('CREATED','PENDING');

CREATE TABLE payments.cash_collections (
  id                         uuid PRIMARY KEY,
  bill_id                    uuid NOT NULL REFERENCES payments.bills(id),
  visit_id                   uuid NOT NULL,   -- ref: jobs.visits
  technician_user_id         uuid NOT NULL,
  amount_paise               bigint NOT NULL CHECK (amount_paise > 0),
  amount_due_at_record_paise bigint NOT NULL,
  recorded_channel           text NOT NULL CHECK (recorded_channel IN ('APP','IVR','OPS_ON_BEHALF')),
  customer_confirmation      text NOT NULL CHECK (customer_confirmation IN ('PENDING','CONFIRMED','DENIED','TIMEOUT')),
  confirmed_channel          text,
  confirmed_at               timestamptz,
  dispute_id                 uuid,   -- ref: trust.disputes
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_paise = amount_due_at_record_paise),   -- INV-24: a mismatch cannot be recorded
  CHECK (customer_confirmation <> 'CONFIRMED' OR (confirmed_at IS NOT NULL AND confirmed_channel IS NOT NULL))
);
CREATE UNIQUE INDEX cash_one_live_per_bill ON payments.cash_collections (bill_id) WHERE customer_confirmation IN ('PENDING','CONFIRMED');

CREATE TABLE payments.payments (
  id                    uuid PRIMARY KEY,
  bill_id               uuid NOT NULL REFERENCES payments.bills(id),
  intent_id             uuid REFERENCES payments.payment_intents(id),
  cash_collection_id    uuid REFERENCES payments.cash_collections(id),
  method                text NOT NULL CHECK (method IN ('UPI','CARD','NETBANKING','CASH')),
  provider              text,
  provider_payment_id   text,
  amount_paise          bigint NOT NULL CHECK (amount_paise > 0),
  refunded_paise        bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  chargeback_lost_paise bigint NOT NULL DEFAULT 0 CHECK (chargeback_lost_paise >= 0),
  status                text NOT NULL CHECK (status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK_OPEN','CHARGEBACK_LOST')),
  captured_at           timestamptz NOT NULL,
  ledger_txn_id         uuid NOT NULL,   -- ref: ledger.transactions
  version               int NOT NULL DEFAULT 0,
  CHECK (refunded_paise + chargeback_lost_paise <= amount_paise),   -- INV-12
  CHECK ((method = 'CASH') = (cash_collection_id IS NOT NULL)),
  CHECK (method = 'CASH' OR (provider IS NOT NULL AND provider_payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX payments_provider_uq ON payments.payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_bill_ix ON payments.payments (bill_id);

CREATE TABLE payments.refunds (
  id                        uuid PRIMARY KEY,
  payment_id                uuid NOT NULL REFERENCES payments.payments(id),
  amount_paise              bigint NOT NULL CHECK (amount_paise > 0),
  reason_code               text NOT NULL,
  bearer                    text NOT NULL CHECK (bearer IN ('PLATFORM','TECHNICIAN','SPLIT')),
  bearer_technician_user_id uuid,
  destination               text NOT NULL CHECK (destination IN ('SOURCE','BANK_PAYOUT')),
  status                    text NOT NULL CHECK (status IN ('REQUESTED','PENDING_APPROVAL','APPROVED','SUBMITTED','SUCCEEDED','FAILED','CANCELLED')),
  requested_by_admin_id     uuid NOT NULL,
  approval_request_id       uuid,   -- ref: backoffice.approval_requests
  linked_dispute_id         uuid,   -- ref: trust.disputes
  provider_refund_id        text,
  idempotency_key           text NOT NULL UNIQUE,
  approve_ledger_txn_id     uuid,
  settle_ledger_txn_id      uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   int NOT NULL DEFAULT 0,
  CHECK (bearer = 'PLATFORM' OR linked_dispute_id IS NOT NULL),   -- technician-borne only via a dispute
  CHECK (bearer = 'PLATFORM' OR bearer_technician_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX refunds_provider_uq ON payments.refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_payment_ix ON payments.refunds (payment_id);

CREATE TABLE payments.chargebacks (
  id                  uuid PRIMARY KEY,
  payment_id          uuid NOT NULL REFERENCES payments.payments(id),
  provider_dispute_id text NOT NULL UNIQUE,
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  reason              text,
  status              text NOT NULL CHECK (status IN ('OPEN','EVIDENCE_SUBMITTED','WON','LOST','ACCEPTED')),
  respond_by          timestamptz,
  evidence_file_id    uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments.invoice_series (
  id          uuid PRIMARY KEY,
  issuer_key  text NOT NULL,
  fiscal_year text NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  prefix      text NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  UNIQUE (issuer_key, fiscal_year)
);

-- Immutable; gapless numbering via a row lock on the series (format pending legal confirmation).
CREATE TABLE payments.invoices (
  id                  uuid PRIMARY KEY,
  series_id           uuid NOT NULL REFERENCES payments.invoice_series(id),
  invoice_number      text NOT NULL UNIQUE,
  kind                text NOT NULL CHECK (kind IN ('INVOICE','CREDIT_NOTE')),
  original_invoice_id uuid REFERENCES payments.invoices(id),
  bill_id             uuid NOT NULL REFERENCES payments.bills(id),
  job_id              uuid NOT NULL,
  issuer_type         text NOT NULL CHECK (issuer_type IN ('PLATFORM','TECHNICIAN_VIA_PLATFORM')),
  lines               jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  taxable_paise       bigint NOT NULL,
  tax_paise           bigint NOT NULL CHECK (tax_paise >= 0),
  total_paise         bigint NOT NULL,
  pdf_file_id         uuid,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'CREDIT_NOTE') = (original_invoice_id IS NOT NULL)),
  CHECK (total_paise = taxable_paise + tax_paise)
);

CREATE TABLE payments.payout_batches (
  id                   uuid PRIMARY KEY,
  city_id              uuid,
  period               tstzrange NOT NULL CHECK (NOT isempty(period)),
  status               text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','EXECUTING','COMPLETED','PARTIALLY_FAILED','CANCELLED')),
  total_net_paise      bigint NOT NULL DEFAULT 0 CHECK (total_net_paise >= 0),
  payout_count         int NOT NULL DEFAULT 0 CHECK (payout_count >= 0),
  prepared_by_admin_id uuid NOT NULL,
  approval_request_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('DRAFT','PENDING_APPROVAL','CANCELLED') OR approval_request_id IS NOT NULL)
);

CREATE TABLE payments.payouts (
  id                   uuid PRIMARY KEY,
  batch_id             uuid NOT NULL REFERENCES payments.payout_batches(id),
  technician_user_id   uuid NOT NULL,
  payout_method_id     uuid NOT NULL,   -- ref: workforce.payout_methods
  gross_payable_paise  bigint NOT NULL CHECK (gross_payable_paise >= 0),
  cash_netted_paise    bigint NOT NULL DEFAULT 0 CHECK (cash_netted_paise >= 0),
  held_paise           bigint NOT NULL DEFAULT 0 CHECK (held_paise >= 0),
  tds_paise            bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  net_paise            bigint NOT NULL CHECK (net_paise > 0),
  status               text NOT NULL CHECK (status IN ('PENDING','SUBMITTED','PAID','FAILED','REVERSED','CANCELLED')),
  provider             text,
  provider_payout_id   text,
  idempotency_key      text NOT NULL UNIQUE,
  failure_code         text,
  submit_ledger_txn_id uuid,
  settle_ledger_txn_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 0,
  CHECK (net_paise = gross_payable_paise - cash_netted_paise - held_paise - tds_paise),
  UNIQUE (batch_id, technician_user_id)
);
CREATE UNIQUE INDEX payouts_provider_uq ON payments.payouts (provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL;

-- Raw webhook store (inserted by the webhook role only), partitioned monthly. Payloads minimised, kept <= 180 days.
CREATE TABLE payments.provider_events (
  id                uuid NOT NULL,
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  signature_valid   boolean NOT NULL,
  payload_enc       bytea NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  processing_status text NOT NULL CHECK (processing_status IN ('PENDING','PROCESSED','IGNORED','FAILED')),
  PRIMARY KEY (id, received_at),
  UNIQUE (provider, provider_event_id, received_at)
) PARTITION BY RANGE (received_at);
SELECT platform.ensure_monthly_partitions('payments.provider_events', 1, 3);

-- Dedupe across partitions.
CREATE TABLE payments.provider_event_keys (
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE payments.reconciliation_exceptions (
  id                   uuid PRIMARY KEY,
  run_id               uuid NOT NULL,
  category             text NOT NULL CHECK (category IN ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER','AMOUNT_MISMATCH','STATUS_MISMATCH',
                                                         'SETTLEMENT_SHORT','UNKNOWN_CREDIT','PAYOUT_MISMATCH')),
  reference            jsonb NOT NULL,
  amount_paise         bigint,
  status               text NOT NULL CHECK (status IN ('OPEN','EXPLAINED','CORRECTED','ESCALATED')),
  resolution_note      text,
  resolved_by_admin_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Guards ------------------------------------------------------------------------------------------------------------

-- A bill's amount due equals the signed sum of its lines (G-8, part of INV-09). Checked at commit, because the bill
-- and its lines are written in the same (completion) transaction.
CREATE FUNCTION payments.check_bill_total() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target uuid;
  due bigint;
  total bigint;
  n bigint;
BEGIN
  -- Separate branches: a field reference is planned only when its branch runs (bills rows have no bill_id).
  IF TG_TABLE_NAME = 'bills' THEN
    target := NEW.id;
  ELSE
    target := NEW.bill_id;
  END IF;
  SELECT b.amount_due_paise, coalesce(sum(l.amount_paise), 0), count(l.id)
    INTO due, total, n
    FROM payments.bills b LEFT JOIN payments.bill_lines l ON l.bill_id = b.id
   WHERE b.id = target
   GROUP BY b.amount_due_paise;
  IF n = 0 OR due <> total THEN
    RAISE EXCEPTION 'bill %: amount due % <> sum of % lines %', target, due, n, total USING ERRCODE = 'HS020';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bill_total_on_bill AFTER INSERT ON payments.bills
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_bill_total();
CREATE CONSTRAINT TRIGGER bill_total_on_line AFTER INSERT ON payments.bill_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_bill_total();

-- Issued bill fields never change; only settlement progresses. Bills are never deleted (void instead).
CREATE FUNCTION payments.guard_bill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  mutable_cols constant text[] := ARRAY['amount_settled_paise','status','settled_at','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bill % cannot be deleted', OLD.id USING ERRCODE = 'HS002';
  END IF;
  IF (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'bill % issued fields are immutable', OLD.id USING ERRCODE = 'HS002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_bill BEFORE UPDATE OR DELETE ON payments.bills FOR EACH ROW EXECUTE FUNCTION payments.guard_bill();

-- Lines are added only to an OPEN, unsettled bill. A prior-payment credit never exceeds what the prior bill settled (G-8).
CREATE FUNCTION payments.guard_bill_line() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  b record;
  prior_settled bigint;
  already_credited bigint;
BEGIN
  SELECT status, amount_settled_paise INTO b FROM payments.bills WHERE id = NEW.bill_id;
  IF b.status IS DISTINCT FROM 'OPEN' OR b.amount_settled_paise <> 0 THEN
    RAISE EXCEPTION 'lines can only be added to an OPEN, unsettled bill (bill %)', NEW.bill_id USING ERRCODE = 'HS002';
  END IF;
  IF NEW.line_type = 'PRIOR_PAYMENT_CREDIT' AND NEW.prior_bill_id IS NOT NULL THEN   -- a missing prior_bill_id is a CHECK violation
    SELECT amount_settled_paise INTO prior_settled FROM payments.bills WHERE id = NEW.prior_bill_id;
    SELECT coalesce(-sum(amount_paise), 0) INTO already_credited FROM payments.bill_lines
     WHERE prior_bill_id = NEW.prior_bill_id AND line_type = 'PRIOR_PAYMENT_CREDIT';
    IF already_credited - NEW.amount_paise > coalesce(prior_settled, 0) THEN
      RAISE EXCEPTION 'prior payment credit exceeds what bill % settled (G-8)', NEW.prior_bill_id USING ERRCODE = 'HS020';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_bill_line BEFORE INSERT ON payments.bill_lines FOR EACH ROW EXECUTE FUNCTION payments.guard_bill_line();

-- INV-12: active refunds for a payment never exceed captured - chargebacks lost. SECURITY DEFINER so the payment row
-- can be locked regardless of the caller's privileges (the search_path is fixed and every name is qualified).
CREATE FUNCTION payments.guard_refund_total() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  p record;
  others bigint;
BEGIN
  SELECT amount_paise, chargeback_lost_paise INTO p FROM payments.payments WHERE id = NEW.payment_id FOR UPDATE;
  SELECT coalesce(sum(amount_paise), 0) INTO others FROM payments.refunds
   WHERE payment_id = NEW.payment_id AND status NOT IN ('FAILED','CANCELLED') AND id <> NEW.id;
  IF NEW.status NOT IN ('FAILED','CANCELLED') AND others + NEW.amount_paise > p.amount_paise - p.chargeback_lost_paise THEN
    RAISE EXCEPTION 'refunds for payment % would exceed captured minus lost chargebacks (INV-12)', NEW.payment_id USING ERRCODE = 'HS020';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION payments.guard_refund_total() FROM PUBLIC;
CREATE TRIGGER guard_refund_total BEFORE INSERT OR UPDATE OF amount_paise, status, payment_id ON payments.refunds
  FOR EACH ROW EXECUTE FUNCTION payments.guard_refund_total();

-- INV-10: an invoice's lines equal the bill's lines at issue time; the total equals the bill lines' sum.
CREATE FUNCTION payments.guard_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  expected jsonb;
  actual jsonb;
  bill_total bigint;
BEGIN
  IF NEW.kind = 'INVOICE' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'line_type', l.line_type, 'amount_paise', l.amount_paise)
                              ORDER BY l.line_no), '[]'::jsonb),
           coalesce(sum(l.amount_paise), 0)
      INTO expected, bill_total
      FROM payments.bill_lines l WHERE l.bill_id = NEW.bill_id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('line_no', (e ->> 'line_no')::int, 'line_type', e ->> 'line_type',
                                                 'amount_paise', (e ->> 'amount_paise')::bigint)
                              ORDER BY (e ->> 'line_no')::int), '[]'::jsonb)
      INTO actual
      FROM jsonb_array_elements(NEW.lines) e;
    IF expected = '[]'::jsonb OR actual IS DISTINCT FROM expected OR NEW.total_paise <> bill_total THEN
      RAISE EXCEPTION 'invoice % does not match the lines of bill % (INV-10)', NEW.invoice_number, NEW.bill_id USING ERRCODE = 'HS020';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_invoice BEFORE INSERT ON payments.invoices FOR EACH ROW EXECUTE FUNCTION payments.guard_invoice();

SELECT platform.make_append_only('payments.bill_lines');
SELECT platform.make_append_only('payments.invoices');
SELECT platform.track_updates('payments.payment_intents');
SELECT platform.track_updates('payments.refunds');
SELECT platform.track_updates('payments.payouts');

SELECT platform.classify('payments.bills', 'I');
SELECT platform.classify('payments.bill_lines', 'I');
-- Payment metadata is confidential (10 §5): need-to-know, masked for support.
SELECT platform.classify('payments.payment_intents', 'C');
SELECT platform.classify('payments.cash_collections', 'C');
SELECT platform.classify('payments.payments', 'C');
SELECT platform.classify('payments.refunds', 'C');
SELECT platform.classify('payments.chargebacks', 'C');
SELECT platform.classify('payments.invoice_series', 'I');
SELECT platform.classify('payments.invoices', 'I');
SELECT platform.classify('payments.payout_batches', 'C');
SELECT platform.classify('payments.payouts', 'C');
SELECT platform.classify('payments.provider_events', 'I', 'payload_enc', 'C,enc');
SELECT platform.classify('payments.provider_event_keys', 'I');
SELECT platform.classify('payments.reconciliation_exceptions', 'I', 'reference', 'C', 'resolution_note', 'C');

SELECT platform.register_encrypted('payments.provider_events', 'payload_enc', 'PLATFORM', NULL, 'RETAIN_AS_EVIDENCE',
  'SR-07 (4): provider payloads are minimised by the adapter and kept <= 180 days (partition drop)');

INSERT INTO platform.archive_policies (table_schema, table_name, hot_retention, archive_mode, legal_basis) VALUES
  ('payments', 'provider_events', interval '180 days', 'DROP_WITHOUT_ARCHIVE', 'SR-07 (4): raw provider payloads kept <= 180 d');

GRANT USAGE ON SCHEMA payments TO app_api, app_admin, app_webhook, app_voice, app_worker;
-- api: issues bills in the completion transaction (TCP-3), creates payment intents, records / confirms cash.
GRANT SELECT, INSERT ON payments.bills, payments.bill_lines TO app_api;
GRANT SELECT, INSERT, UPDATE ON payments.payment_intents, payments.cash_collections TO app_api;
GRANT SELECT ON payments.payments, payments.refunds, payments.invoices, payments.payouts TO app_api;
-- admin: finance / support views and maker-checker money actions. No ledger writes (G-5).
GRANT SELECT ON payments.bills, payments.bill_lines, payments.payment_intents, payments.payments, payments.invoice_series,
      payments.invoices, payments.payouts, payments.provider_events, payments.provider_event_keys TO app_admin;
GRANT SELECT, INSERT, UPDATE ON payments.refunds, payments.chargebacks, payments.payout_batches, payments.cash_collections TO app_admin;
GRANT SELECT, UPDATE ON payments.reconciliation_exceptions TO app_admin;
-- webhook: insert raw events only (03 §12.1).
GRANT INSERT ON payments.provider_events, payments.provider_event_keys TO app_webhook;
-- voice: cash collected via IVR (X-11).
GRANT INSERT ON payments.cash_collections TO app_voice;
-- worker: event processing, captures, refunds, payouts, reconciliation.
GRANT SELECT, INSERT, UPDATE ON payments.bills, payments.payment_intents, payments.cash_collections, payments.payments,
      payments.refunds, payments.chargebacks, payments.invoice_series, payments.payout_batches, payments.payouts,
      payments.provider_events, payments.provider_event_keys, payments.reconciliation_exceptions TO app_worker;
GRANT SELECT, INSERT ON payments.bill_lines, payments.invoices TO app_worker;
