-- ledger (owned by the payments module): double-entry, append-only. Phase 1 09 §3, §5, §7; INV-11, INV-28; G-5 / SR-18 /
-- B10: app_worker is the ONLY role that can write here. Ledger invariants enforced in the database:
--   L1 every transaction balances (sum of debits = sum of credits) with >= 2 entries in one currency (checked at commit)
--   L2 rows are never updated or deleted          L3 one transaction per business event (idempotency_key)
--   L4 a reversal mirrors its original exactly; at most one reversal per original
--   L10 no forbidden account subtype (no customer stored value)
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA ledger;

CREATE TABLE ledger.accounts (
  id           uuid PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  account_type text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE')),
  subtype      text NOT NULL CHECK (subtype IN ('CUSTOMER_RECEIVABLE','PA_CLEARING','BANK_SETTLEMENT','PAYOUT_IN_TRANSIT',
                 'TECH_CASH_HELD','CHARGEBACK_HOLD','TECH_PAYABLE','CUSTOMER_REFUND_PAYABLE','TAX_PAYABLE','TDS_PAYABLE','SUSPENSE',
                 'REV_COMMISSION','REV_VISIT_FEE','REV_CANCELLATION','EXP_DIAGNOSIS_PAYOUT','EXP_PA_FEES','EXP_GOODWILL',
                 'EXP_WARRANTY','EXP_CHARGEBACK_LOSS','EXP_BAD_DEBT')),   -- L10 / INV-28 allowlist: no customer stored value
  owner_type   text CHECK (owner_type IN ('TECHNICIAN','BILL','TAX','PLATFORM')),
  owner_id     uuid,
  currency     char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (subtype, owner_id),
  CHECK (CASE
           WHEN subtype IN ('TECH_PAYABLE','TECH_CASH_HELD') THEN owner_type = 'TECHNICIAN' AND owner_id IS NOT NULL
           WHEN subtype IN ('CUSTOMER_RECEIVABLE','CUSTOMER_REFUND_PAYABLE') THEN owner_type = 'BILL' AND owner_id IS NOT NULL
           WHEN subtype = 'TAX_PAYABLE' THEN owner_type = 'TAX' AND owner_id IS NOT NULL
           ELSE owner_type IS DISTINCT FROM 'TECHNICIAN' AND owner_type IS DISTINCT FROM 'BILL'
         END),
  CHECK (CASE
           WHEN subtype IN ('CUSTOMER_RECEIVABLE','PA_CLEARING','BANK_SETTLEMENT','PAYOUT_IN_TRANSIT','TECH_CASH_HELD','CHARGEBACK_HOLD') THEN account_type = 'ASSET'
           WHEN subtype IN ('TECH_PAYABLE','CUSTOMER_REFUND_PAYABLE','TAX_PAYABLE','TDS_PAYABLE','SUSPENSE') THEN account_type = 'LIABILITY'
           WHEN subtype LIKE 'REV\_%' THEN account_type = 'REVENUE'
           ELSE account_type = 'EXPENSE'
         END)
);

CREATE TABLE ledger.transactions (
  id                    uuid PRIMARY KEY,
  txn_type              text NOT NULL,
  idempotency_key       text NOT NULL UNIQUE,   -- L3: deterministic from the business event
  reference_type        text NOT NULL,
  reference_id          uuid NOT NULL,
  reason_code           text,
  reverses_txn_id       uuid REFERENCES ledger.transactions(id),
  effective_at          timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type text NOT NULL,
  created_by_actor_id   uuid,
  approval_request_id   uuid,
  CHECK (reverses_txn_id IS NULL OR reverses_txn_id <> id)
);
CREATE UNIQUE INDEX ledger_one_reversal_uq ON ledger.transactions (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;   -- L4
CREATE INDEX ledger_txn_reference_ix ON ledger.transactions (reference_type, reference_id);

CREATE TABLE ledger.entries (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger.transactions(id),
  account_id     uuid NOT NULL REFERENCES ledger.accounts(id),
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  currency       char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_ix ON ledger.entries (account_id, seq);
CREATE INDEX entries_txn_ix ON ledger.entries (transaction_id);

CREATE TABLE ledger.balance_snapshots (
  account_id   uuid NOT NULL REFERENCES ledger.accounts(id),
  as_of_seq    bigint NOT NULL,
  debit_total  bigint NOT NULL CHECK (debit_total >= 0),
  credit_total bigint NOT NULL CHECK (credit_total >= 0),
  computed_at  timestamptz NOT NULL,
  PRIMARY KEY (account_id, as_of_seq)
);

-- L1 + L4, evaluated at commit for every transaction touched in the commit.
CREATE FUNCTION ledger.assert_transaction_valid(txn uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  n bigint;
  net numeric;
  currencies bigint;
  original uuid;
  mismatch boolean;
BEGIN
  SELECT count(*), coalesce(sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_paise ELSE -e.amount_paise END), 0), count(DISTINCT e.currency)
    INTO n, net, currencies
    FROM ledger.entries e WHERE e.transaction_id = txn;
  IF n < 2 OR net <> 0 OR currencies <> 1 THEN
    RAISE EXCEPTION 'ledger transaction % is invalid: % entries, net %, % currencies (L1 / INV-11)', txn, n, net, currencies
      USING ERRCODE = 'HS010';
  END IF;
  SELECT t.reverses_txn_id INTO original FROM ledger.transactions t WHERE t.id = txn;
  IF original IS NOT NULL THEN
    SELECT EXISTS (
      (SELECT e.account_id, CASE e.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, e.amount_paise, count(*)
         FROM ledger.entries e WHERE e.transaction_id = original GROUP BY 1, 2, 3
       EXCEPT
       SELECT e.account_id, e.direction, e.amount_paise, count(*)
         FROM ledger.entries e WHERE e.transaction_id = txn GROUP BY 1, 2, 3)
      UNION ALL
      (SELECT e.account_id, e.direction, e.amount_paise, count(*)
         FROM ledger.entries e WHERE e.transaction_id = txn GROUP BY 1, 2, 3
       EXCEPT
       SELECT e.account_id, CASE e.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, e.amount_paise, count(*)
         FROM ledger.entries e WHERE e.transaction_id = original GROUP BY 1, 2, 3)
    ) INTO mismatch;
    IF mismatch THEN
      RAISE EXCEPTION 'ledger transaction % does not exactly mirror the transaction it reverses (L4)', txn USING ERRCODE = 'HS010';
    END IF;
  END IF;
END $$;

CREATE FUNCTION ledger.check_entry_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM ledger.assert_transaction_valid(NEW.transaction_id);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger.check_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM ledger.assert_transaction_valid(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.check_entry_transaction();
CREATE CONSTRAINT TRIGGER transaction_balanced AFTER INSERT ON ledger.transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.check_transaction();

SELECT platform.make_append_only('ledger.accounts');
SELECT platform.make_append_only('ledger.transactions');
SELECT platform.make_append_only('ledger.entries');

SELECT platform.classify('ledger.accounts', 'I');
SELECT platform.classify('ledger.transactions', 'I');
SELECT platform.classify('ledger.entries', 'I');
SELECT platform.classify('ledger.balance_snapshots', 'I');

REVOKE ALL ON FUNCTION ledger.assert_transaction_valid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.assert_transaction_valid(uuid) TO app_worker;

-- G-5 / B10: only the worker writes; finance (admin) reads. api / voice / webhook have no access to the schema at all.
GRANT USAGE ON SCHEMA ledger TO app_admin, app_worker;
GRANT SELECT ON ledger.accounts, ledger.transactions, ledger.entries, ledger.balance_snapshots TO app_admin;
GRANT SELECT, INSERT ON ledger.accounts, ledger.transactions, ledger.entries, ledger.balance_snapshots TO app_worker;
