# Phase 1 · 09 — Payments & Double-Entry Ledger

> Status: **DRAFT for founder review** · Date: 2026-10-08
> ⚖️ **The money-flow legal model (who collects, on whose behalf, who invoices, GST/TDS treatment) needs Indian legal and CA advice before Phase 2 payments work starts.** The ledger design below works for both candidate models. Only account naming and tax postings change.

---

## 1. Principles

1. **Integer paise** everywhere. Rounding is explicit and documented (§9).
2. **Double-entry:** every money movement or obligation is a balanced ledger transaction (Σ debits = Σ credits).
3. **Append-only:** no UPDATE/DELETE on ledger rows. Corrections are **compensating transactions** that reference the original (`reverses_txn_id`).
4. **Provider state is verified, never assumed.** Client callbacks are ignored for money state. Webhooks trigger a **server-side status fetch** before posting.
5. **Idempotent postings:** each ledger transaction has a deterministic idempotency key derived from the business event (`bill:<id>:issue`, `payment:<providerId>:capture`, …).
6. **No stored value for customers** (no wallet, ADR-011). Technician *payable* balances are obligations paid out on schedule. They can't be spent, transferred or topped up, and they earn no interest.
7. **Every rupee a technician sees has a reason:** statements are generated from ledger entries with explicit line types (no "adjustments" without a reason code).

---

## 2. Legal/operational models (⚖️ decide with counsel and CA)

| | **Model A: split settlement via PA** | **Model B: platform collects, then pays out** |
|---|---|---|
| Flow | Customer → PA → PA splits at settlement: technician share to technician's **linked account** at the PA, platform commission to the platform | Customer → PA → platform's settlement account. The platform pays technicians via the PA's **payouts** product |
| Technician onboarding at PA | Each technician needs a linked account (KYC at the PA: PAN typically required) | Only a verified bank account/UPI is needed (penny-drop) |
| Fit for basic-phone/low-documentation technicians | **Weaker** (PAN/KYC friction) | **Better** |
| Regulatory exposure | Lower for the platform (funds flow under the PA's escrow) | Platform temporarily holds funds owed to technicians. Need to confirm this is permissible as a marketplace collecting as an agent, and not an activity requiring PA authorisation ⚖️ |
| Cash jobs | Commission receivable from the technician, netted manually | Same, netted in payouts |
| **Recommendation** | — | **Model B for V1 if counsel confirms**, with a contractual agency arrangement and PA-held escrow/nodal settlement. Model A as the fallback. The ledger supports both. |

Also ⚖️: GST liability of the platform as an e-commerce operator for notified services (s.9(5)), TCS (s.52) applicability, TDS under s.194-O on payments to technicians, invoice issuer and numbering, and the Consumer Protection (E-Commerce) Rules 2020 seller-information display obligations.

---

## 3. Chart of accounts (V1)

| Code (per owner where `:id`) | Type | Normal | Meaning |
|---|---|---|---|
| `CUSTOMER_RECEIVABLE:<billId>` | Asset | Dr | Amount the customer owes for a bill |
| `PA_CLEARING` | Asset | Dr | Captured by the PA, not yet settled to our bank |
| `BANK_SETTLEMENT` | Asset | Dr | Settlement bank account |
| `PAYOUT_IN_TRANSIT` | Asset (contra) | Dr | Payouts submitted, not yet confirmed |
| `TECH_CASH_HELD:<techId>` | Asset | Dr | Cash collected by the technician on the platform's behalf (receivable from the technician) |
| `CHARGEBACK_HOLD` | Asset | Dr | Amounts debited by the PA for open chargebacks |
| `TECH_PAYABLE:<techId>` | Liability | Cr | Earnings owed to the technician |
| `CUSTOMER_REFUND_PAYABLE:<billId>` | Liability | Cr | Refunds approved, not yet completed |
| `TAX_PAYABLE:<taxCode>` | Liability | Cr | GST etc. (only once tax rules are approved ⚖️) |
| `TDS_PAYABLE` | Liability | Cr | TDS withheld (⚖️) |
| `SUSPENSE` | Liability | Cr | Unmatched money pending investigation (must trend to zero) |
| `REV_COMMISSION` | Revenue | Cr | Platform commission/margin (naming depends on principal vs agent ⚖️) |
| `REV_VISIT_FEE` | Revenue | Cr | Platform share of visit fees |
| `REV_CANCELLATION` | Revenue | Cr | Platform share of cancellation/no-show/waiting fees |
| `EXP_DIAGNOSIS_PAYOUT` | Expense | Dr | Diagnosis payouts funded by the platform (when the visit fee is credited) |
| `EXP_PA_FEES` | Expense | Dr | Gateway fees |
| `EXP_GOODWILL` | Expense | Dr | Platform-borne refunds/compensation |
| `EXP_WARRANTY` | Expense | Dr | Platform-borne warranty revisits |
| `EXP_CHARGEBACK_LOSS` | Expense | Dr | Lost chargebacks |
| `EXP_BAD_DEBT` | Expense | Dr | Written-off receivables (maker-checker) |

There is **no customer-owned stored-value account type** (enforced by an account-type allowlist, INV-28).

---

## 4. Money flows & postings

### 4.1 Worked example: separate diagnosis and repair visits (illustrative numbers, all configurable)
Config (example only): visit fee ₹149, credited if the repair is approved. Diagnosis payout ₹100. Labour technician share 80%. Material passed through at cost. No platform fee. Tax rules not yet active.

| Event | Posting (Dr / Cr) |
|---|---|
| V1 diagnosis completed (Imran) | Dr `EXP_DIAGNOSIS_PAYOUT` 100 / Cr `TECH_PAYABLE:imran` 100 |
| Quote v1 approved (no money yet) | — |
| V2 repair completed (Ramesh). Bill issued: labour 250 + material 150 + visit fee 149 − credit 149 = **400** | Dr `CUSTOMER_RECEIVABLE:B1` 400 / Cr `TECH_PAYABLE:ramesh` 350 (200 labour share + 150 material) / Cr `REV_COMMISSION` 50 |
| Customer pays ₹400 by UPI (verified capture) | Dr `PA_CLEARING` 400 / Cr `CUSTOMER_RECEIVABLE:B1` 400 |
| PA settles ₹392 (fee ₹8) | Dr `BANK_SETTLEMENT` 392, Dr `EXP_PA_FEES` 8 / Cr `PA_CLEARING` 400 |
| Weekly payout | Dr `TECH_PAYABLE:*` / Cr `PAYOUT_IN_TRANSIT` → on confirmation Dr `PAYOUT_IN_TRANSIT` / Cr `BANK_SETTLEMENT` |

**Platform result on this job:** commission 50 − diagnosis payout 100 − PA fees 8 = **−₹58**. ⚠️ This shows a real pricing issue: **crediting the full visit fee while paying a separate diagnosis technician can make a job loss-making.** The pricing simulator must show the per-job margin for each scenario (same visit / same technician later / specialist), and the founder must choose a policy (README decision **D-07**).

### 4.2 Quote rejected (visit fee only)
Bill 149: Dr `CUSTOMER_RECEIVABLE` 149 / Cr `REV_VISIT_FEE` 149. (The diagnosis payout was already expensed at visit completion.)

### 4.3 Same-visit repair, same technician
At visit completion: diagnosis payout + repair share are both credited to the same technician. (The policy may instead fold the diagnosis payout into labour when the same technician repairs: config `diagnosis_payout_when_same_tech_repairs = FULL | NONE | PARTIAL`.)

### 4.4 Cash job
| Event | Posting |
|---|---|
| Technician records ₹400 cash, the customer confirms | Dr `TECH_CASH_HELD:ramesh` 400 / Cr `CUSTOMER_RECEIVABLE:B1` 400 |
| Netting at payout | Dr `TECH_PAYABLE:ramesh` 350 / Cr `TECH_CASH_HELD:ramesh` 350 → the technician owes ₹50 (debit balance remains on `TECH_CASH_HELD`) |
| Technician's net position < −`cash_negative_cap` | No new **cash** jobs for that technician (online-pay jobs only) until settled. The technician can settle by UPI to a collect link (Dr `PA_CLEARING` / Cr `TECH_CASH_HELD`). Shown transparently in their statement. |
| Customer **denies** paying cash | No posting. Dispute opened (INV-24). The bill stays OPEN until decided. |

### 4.5 Refunds (full/partial)
| Event | Posting |
|---|---|
| Refund approved, platform-borne (goodwill/service failure) | Dr `EXP_GOODWILL` X / Cr `CUSTOMER_REFUND_PAYABLE:B` X |
| Refund approved, technician-borne (**only after a DECIDED dispute or technician acceptance**) | Dr `TECH_PAYABLE:tech` X / Cr `CUSTOMER_REFUND_PAYABLE:B` X |
| Refund succeeded at PA | Dr `CUSTOMER_REFUND_PAYABLE:B` X / Cr `PA_CLEARING` X (or `BANK_SETTLEMENT` per PA mechanics) |
| Refund failed | No posting change. Retry. After N failures → refund to a verified bank account via payout (FIN approval) |
| Cash payment refund | Customer refund via payout to the customer's verified UPI/bank (FIN approval). There's no "source" instrument |

Constraint: Σ refunds ≤ captured − lost chargebacks (INV-12), enforced with a row lock on the payment.

### 4.6 Cancellation, waiting, no-show compensation
Bill for the fee F with technician compensation C (both from the policy snapshot):
Dr `CUSTOMER_RECEIVABLE` F / Cr `TECH_PAYABLE:tech` C / Cr `REV_CANCELLATION` F−C.
If F < C (policy guarantees a minimum compensation): Dr `EXP_GOODWILL` (C−F) is added. **Technician compensation accrues even if the customer never pays** (dignity principle; the platform bears the bad debt): an unpaid F is later written off via `EXP_BAD_DEBT`.

### 4.7 Failed payments
Intents FAILED/EXPIRED → **no ledger postings**. The bill stays OPEN. Reminders. Alternative methods offered.

### 4.8 Chargebacks
| Event | Posting |
|---|---|
| PA notifies + debits the disputed amount | Dr `CHARGEBACK_HOLD` X / Cr `PA_CLEARING`/`BANK_SETTLEMENT` X |
| Won | Reverse: Dr `BANK_SETTLEMENT` X / Cr `CHARGEBACK_HOLD` X |
| Lost, platform-borne | Dr `EXP_CHARGEBACK_LOSS` X / Cr `CHARGEBACK_HOLD` X |
| Lost, technician at fault (decided dispute) | Dr `TECH_PAYABLE:tech` X / Cr `CHARGEBACK_HOLD` X |

An evidence pack is generated automatically from the approval proof, presence proofs and timeline.

### 4.9 Payouts and reversals
| Event | Posting |
|---|---|
| Batch approved, payout submitted | Dr `TECH_PAYABLE:t` N / Cr `PAYOUT_IN_TRANSIT` N |
| PAID (verified) | Dr `PAYOUT_IN_TRANSIT` N / Cr `BANK_SETTLEMENT` N |
| FAILED (before debit) | Reverse the submission: Dr `PAYOUT_IN_TRANSIT` N / Cr `TECH_PAYABLE:t` N |
| REVERSED (bank return after PAID) | Dr `BANK_SETTLEMENT` N / Cr `PAYOUT_IN_TRANSIT` N, then Dr `PAYOUT_IN_TRANSIT` N / Cr `TECH_PAYABLE:t` N. Payout method flagged. Ops contacts the technician |
| TDS withheld (⚖️ if applicable) | Dr `TECH_PAYABLE:t` / Cr `TDS_PAYABLE` (shown on the statement) |

### 4.10 Taxes (⚖️ placeholder)
Tax lines are computed by `pricing.tax_rules` (inactive until CA sign-off) and appear as separate quote/bill lines. Postings: Cr `TAX_PAYABLE:<code>` for the tax portion of the customer receivable. GST on platform commission/fees charged to technicians (if any) is posted against `TECH_PAYABLE`. **No tax logic is hard-coded.**

### 4.11 Warranty revisit
Cost-bearer per policy snapshot: platform → `EXP_WARRANTY`. Original technician → Dr `TECH_PAYABLE:orig` **only after a decided dispute or acceptance**. Split → both. The revisit technician is paid normally.

### 4.12 Write-off
`EXP_BAD_DEBT` Dr / `CUSTOMER_RECEIVABLE` Cr. Finance maker-checker. Reason code. The customer may be flagged for future bookings (ops review).

---

## 5. Schema

```sql
-- ledger
CREATE TABLE ledger.accounts (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,                    -- e.g. 'TECH_PAYABLE:<uuid>'
  account_type text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE')),
  subtype text NOT NULL CHECK (subtype IN ('CUSTOMER_RECEIVABLE','PA_CLEARING','BANK_SETTLEMENT','PAYOUT_IN_TRANSIT',
     'TECH_CASH_HELD','CHARGEBACK_HOLD','TECH_PAYABLE','CUSTOMER_REFUND_PAYABLE','TAX_PAYABLE','TDS_PAYABLE','SUSPENSE',
     'REV_COMMISSION','REV_VISIT_FEE','REV_CANCELLATION','EXP_DIAGNOSIS_PAYOUT','EXP_PA_FEES','EXP_GOODWILL',
     'EXP_WARRANTY','EXP_CHARGEBACK_LOSS','EXP_BAD_DEBT')),    -- allowlist: no customer stored-value type (INV-28)
  owner_type text CHECK (owner_type IN ('TECHNICIAN','BILL','TAX','PLATFORM')),
  owner_id uuid,
  currency char(3) NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (subtype, owner_id)
);
CREATE TABLE ledger.transactions (              -- append-only
  id uuid PRIMARY KEY,
  txn_type text NOT NULL,                       -- 'BILL_ISSUE','PAYMENT_CAPTURE','CASH_CONFIRM','REFUND_APPROVE',...
  idempotency_key text NOT NULL UNIQUE,         -- deterministic from the business event
  reference_type text NOT NULL, reference_id uuid NOT NULL,
  reason_code text,
  reverses_txn_id uuid REFERENCES ledger.transactions(id),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type text NOT NULL, created_by_actor_id uuid,
  approval_request_id uuid
);
CREATE UNIQUE INDEX ledger_one_reversal_uq ON ledger.transactions (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE TABLE ledger.entries (                   -- append-only
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger.transactions(id),
  account_id uuid NOT NULL REFERENCES ledger.accounts(id),
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_ix ON ledger.entries (account_id, seq);
CREATE INDEX entries_txn_ix ON ledger.entries (transaction_id);
-- DEFERRABLE INITIALLY DEFERRED constraint trigger on entries: for each touched transaction_id,
--   SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) = 0  AND  COUNT(*) >= 2  (INV-11)
-- BEFORE UPDATE OR DELETE trigger on transactions/entries: RAISE EXCEPTION
CREATE TABLE ledger.balance_snapshots (
  account_id uuid NOT NULL REFERENCES ledger.accounts(id), as_of_seq bigint NOT NULL,
  debit_total bigint NOT NULL, credit_total bigint NOT NULL, computed_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, as_of_seq)
);

-- payments
CREATE TABLE payments.bills (
  id uuid PRIMARY KEY, job_id uuid NOT NULL, bill_no smallint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FINAL','VISIT_FEE','CANCELLATION','NO_SHOW','WAITING','ADJUSTMENT')),
  quote_version_id uuid, price_snapshot_id uuid NOT NULL,
  amount_due_paise bigint NOT NULL CHECK (amount_due_paise >= 0),
  amount_settled_paise bigint NOT NULL DEFAULT 0 CHECK (amount_settled_paise >= 0),
  status text NOT NULL CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','VOID','WRITTEN_OFF')),
  issued_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz, version int NOT NULL DEFAULT 0,
  UNIQUE (job_id, bill_no),
  CHECK (amount_settled_paise <= amount_due_paise),
  CHECK (status <> 'PAID' OR (amount_settled_paise = amount_due_paise AND settled_at IS NOT NULL))
);
CREATE TABLE payments.bill_lines (                  -- immutable
  id uuid PRIMARY KEY, bill_id uuid NOT NULL REFERENCES payments.bills(id), line_no smallint NOT NULL,
  line_type text NOT NULL CHECK (line_type IN ('VISIT_FEE','VISIT_FEE_CREDIT','LABOUR','MATERIAL','UNUSED_MATERIAL_CREDIT',
                                               'PLATFORM_FEE','CANCELLATION_FEE','WAITING_FEE','NO_SHOW_FEE','DISCOUNT','TAX','PRIOR_PAYMENT_CREDIT')),  -- G-8
  quote_item_id uuid, prior_bill_id uuid REFERENCES payments.bills(id),   -- required for PRIOR_PAYMENT_CREDIT (G-8)
  label_key text NOT NULL, label_params jsonb NOT NULL DEFAULT '{}',
  amount_paise bigint NOT NULL,                     -- signed: credits negative
  technician_user_id uuid, technician_share_paise bigint NOT NULL DEFAULT 0,
  UNIQUE (bill_id, line_no)
);
CREATE TABLE payments.payment_intents (
  id uuid PRIMARY KEY, bill_id uuid NOT NULL REFERENCES payments.bills(id), customer_user_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), currency char(3) NOT NULL DEFAULT 'INR',
  provider text NOT NULL, provider_order_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED','CANCELLED')),
  failure_code text, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0,
  UNIQUE (provider, provider_order_id)
);
CREATE UNIQUE INDEX one_live_intent_per_bill ON payments.payment_intents (bill_id) WHERE status IN ('CREATED','PENDING');
CREATE TABLE payments.payments (                    -- captured money only
  id uuid PRIMARY KEY, bill_id uuid NOT NULL REFERENCES payments.bills(id),
  intent_id uuid REFERENCES payments.payment_intents(id), cash_collection_id uuid,
  method text NOT NULL CHECK (method IN ('UPI','CARD','NETBANKING','CASH')),
  provider text, provider_payment_id text,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  refunded_paise bigint NOT NULL DEFAULT 0, chargeback_lost_paise bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK_OPEN','CHARGEBACK_LOST')),
  captured_at timestamptz NOT NULL, ledger_txn_id uuid NOT NULL, version int NOT NULL DEFAULT 0,
  CHECK (refunded_paise + chargeback_lost_paise <= amount_paise),       -- INV-12
  CHECK ((method = 'CASH') = (cash_collection_id IS NOT NULL)),
  CHECK (method = 'CASH' OR (provider IS NOT NULL AND provider_payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX payments_provider_uq ON payments.payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE TABLE payments.cash_collections (
  id uuid PRIMARY KEY, bill_id uuid NOT NULL REFERENCES payments.bills(id), visit_id uuid NOT NULL,
  technician_user_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), amount_due_at_record_paise bigint NOT NULL,
  recorded_channel text NOT NULL CHECK (recorded_channel IN ('APP','IVR','OPS_ON_BEHALF')),
  customer_confirmation text NOT NULL CHECK (customer_confirmation IN ('PENDING','CONFIRMED','DENIED','TIMEOUT')),
  confirmed_channel text, confirmed_at timestamptz, dispute_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_paise = amount_due_at_record_paise)                  -- INV-24 (mismatch can't be recorded)
);
CREATE UNIQUE INDEX cash_one_live_per_bill ON payments.cash_collections (bill_id) WHERE customer_confirmation IN ('PENDING','CONFIRMED');
CREATE TABLE payments.refunds (
  id uuid PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments.payments(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), reason_code text NOT NULL,
  bearer text NOT NULL CHECK (bearer IN ('PLATFORM','TECHNICIAN','SPLIT')), bearer_technician_user_id uuid,
  destination text NOT NULL CHECK (destination IN ('SOURCE','BANK_PAYOUT')),
  status text NOT NULL CHECK (status IN ('REQUESTED','PENDING_APPROVAL','APPROVED','SUBMITTED','SUCCEEDED','FAILED','CANCELLED')),
  requested_by_admin_id uuid NOT NULL, approval_request_id uuid,
  linked_dispute_id uuid, provider_refund_id text, idempotency_key text NOT NULL UNIQUE,
  approve_ledger_txn_id uuid, settle_ledger_txn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0,
  CHECK (bearer = 'PLATFORM' OR linked_dispute_id IS NOT NULL)        -- technician-borne only via dispute
);
CREATE UNIQUE INDEX refunds_provider_uq ON payments.refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE TABLE payments.chargebacks (
  id uuid PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments.payments(id),
  provider_dispute_id text NOT NULL UNIQUE, amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  reason text, status text NOT NULL CHECK (status IN ('OPEN','EVIDENCE_SUBMITTED','WON','LOST','ACCEPTED')),
  respond_by timestamptz, evidence_file_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.invoice_series (
  id uuid PRIMARY KEY, issuer_key text NOT NULL, fiscal_year text NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  prefix text NOT NULL, next_number bigint NOT NULL DEFAULT 1,
  UNIQUE (issuer_key, fiscal_year)
);
CREATE TABLE payments.invoices (                    -- immutable; gapless numbering via row lock on series (⚖️ format)
  id uuid PRIMARY KEY, series_id uuid NOT NULL REFERENCES payments.invoice_series(id),
  invoice_number text NOT NULL UNIQUE, kind text NOT NULL CHECK (kind IN ('INVOICE','CREDIT_NOTE')),
  original_invoice_id uuid REFERENCES payments.invoices(id),
  bill_id uuid NOT NULL REFERENCES payments.bills(id), job_id uuid NOT NULL,
  issuer_type text NOT NULL CHECK (issuer_type IN ('PLATFORM','TECHNICIAN_VIA_PLATFORM')),
  lines jsonb NOT NULL, taxable_paise bigint NOT NULL, tax_paise bigint NOT NULL, total_paise bigint NOT NULL,
  pdf_file_id uuid, issued_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'CREDIT_NOTE') = (original_invoice_id IS NOT NULL))
);
CREATE TABLE payments.payout_batches (
  id uuid PRIMARY KEY, city_id uuid, period tstzrange NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','EXECUTING','COMPLETED','PARTIALLY_FAILED','CANCELLED')),
  total_net_paise bigint NOT NULL DEFAULT 0, payout_count int NOT NULL DEFAULT 0,
  prepared_by_admin_id uuid NOT NULL, approval_request_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.payouts (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES payments.payout_batches(id),
  technician_user_id uuid NOT NULL, payout_method_id uuid NOT NULL,
  gross_payable_paise bigint NOT NULL, cash_netted_paise bigint NOT NULL DEFAULT 0, held_paise bigint NOT NULL DEFAULT 0,
  tds_paise bigint NOT NULL DEFAULT 0, net_paise bigint NOT NULL CHECK (net_paise > 0),
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTED','PAID','FAILED','REVERSED','CANCELLED')),
  provider text, provider_payout_id text, idempotency_key text NOT NULL UNIQUE, failure_code text,
  submit_ledger_txn_id uuid, settle_ledger_txn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0,
  CHECK (net_paise = gross_payable_paise - cash_netted_paise - held_paise - tds_paise),
  UNIQUE (batch_id, technician_user_id)
);
CREATE UNIQUE INDEX payouts_provider_uq ON payments.payouts (provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL;
CREATE TABLE payments.provider_events (             -- raw webhook store, partitioned monthly
  id uuid NOT NULL, provider text NOT NULL, provider_event_id text NOT NULL, event_type text NOT NULL,
  signature_valid boolean NOT NULL, payload_enc bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  processing_status text NOT NULL CHECK (processing_status IN ('PENDING','PROCESSED','IGNORED','FAILED')),
  PRIMARY KEY (id, received_at), UNIQUE (provider, provider_event_id, received_at)
) PARTITION BY RANGE (received_at);
-- Dedupe across partitions: a separate unpartitioned table provider_event_keys(provider, provider_event_id) PRIMARY KEY.
CREATE TABLE payments.reconciliation_exceptions (
  id uuid PRIMARY KEY, run_id uuid NOT NULL, category text NOT NULL CHECK (category IN
   ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER','AMOUNT_MISMATCH','STATUS_MISMATCH','SETTLEMENT_SHORT','UNKNOWN_CREDIT','PAYOUT_MISMATCH')),
  reference jsonb NOT NULL, amount_paise bigint, status text NOT NULL CHECK (status IN ('OPEN','EXPLAINED','CORRECTED','ESCALATED')),
  resolution_note text, resolved_by_admin_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 6. Provider integration rules

1. **Create the intent** server-side with the exact bill amount. The client gets only an order ID + publishable key.
2. **Webhook** → verify signature → insert into `provider_events` (dedupe key) → 200 → async processor.
3. The processor **fetches the payment from the PA API** (amount, currency, status, order ID) and checks: order matches the intent, amount equals the intent amount, currency INR. A mismatch → `SUSPENSE` posting + P1 alert. **Never** trust the webhook body's amount alone.
4. Capture posting in one transaction, **executed by the worker role, which is the only ledger writer (G-5)**: `payments` row + ledger transaction + bill settlement update + outbox `PaymentCaptured`. Bills themselves are issued synchronously at completion (TCP-3). Their ledger posting follows asynchronously in the worker. Idempotency key `payment:<provider>:<providerPaymentId>:capture`.
5. **Late success after EXPIRED intent** (customer paid after the timeout): still captured. If the bill was already paid by another method → automatic refund request (platform-borne, no approval below threshold) + customer notification.
6. **Double payment** (two intents succeed): the second → automatic refund (as above). The unique live-intent index makes this rare.
7. **Polling backstop:** intents PENDING > 10 min are fetched every 5 min until 24 h.
8. Refunds/payouts: provider idempotency keys = our row IDs. Retries reuse them. Status confirmed by webhook + fetch.

---

## 7. Ledger invariants (automated checks)

| ID | Invariant | Check |
|---|---|---|
| L1 | Each transaction balances (Σ Dr = Σ Cr) with ≥ 2 entries | Deferred trigger + nightly full scan |
| L2 | Ledger rows are never updated or deleted | Grants + triggers + nightly row-count/hash checkpoint |
| L3 | Each transaction is unique per business event | `idempotency_key` UNIQUE |
| L4 | A reversal mirrors its original exactly, and an original has at most one reversal | Trigger + unique index |
| L5 | `CUSTOMER_REFUND_PAYABLE`, `PAYOUT_IN_TRANSIT` and `SUSPENSE` balances trend to zero (aging alerts at 3/7 days) | Daily job |
| L6 | `CUSTOMER_RECEIVABLE:<bill>` balance = bill amount due − settled | Daily job per open bill |
| L7 | Σ technician payouts in a batch ≤ Σ available (`TECH_PAYABLE` − `TECH_CASH_HELD` − holds) at build time | Batch builder + check |
| L8 | `PA_CLEARING` matches the PA's unsettled balance after each settlement report | Reconciliation |
| L9 | Bill status and amounts agree with the ledger | Nightly |
| L10 | No account of a forbidden subtype exists (no customer stored value) | Allowlist CHECK |

A failed invariant check is a **SEV2 incident**: finance + engineering are paged, and payout batches are blocked until resolved.

---

## 8. Reconciliation

| Run | Frequency | Compares | Exceptions |
|---|---|---|---|
| Payments | Hourly + daily | PA payments API/report vs `payments` + ledger captures | missing either side, amount/status mismatch |
| Settlements | Daily | PA settlement report vs `BANK_SETTLEMENT` credits and `PA_CLEARING` | short settlement, fees mismatch |
| Refunds | Daily | PA refunds vs `refunds` | stuck SUBMITTED > 48 h |
| Chargebacks | Daily | PA disputes vs `chargebacks` | missing evidence deadlines |
| Payouts | After each batch + daily | Payout provider statuses vs `payouts` | FAILED/REVERSED |
| Cash | Daily | Unconfirmed cash collections, `TECH_CASH_HELD` aging | > 7 days, > cap |

Exceptions go to a finance queue. Corrections are **only** through compensating transactions (with reason codes and maker-checker for amounts above threshold). Unexplained money goes to `SUSPENSE`, never into revenue.

---

## 9. Rounding & amounts
- All arithmetic is in integer paise. Percentages are in bps. Split computations use the **largest-remainder method** so that parts sum exactly to the whole (e.g., technician share + commission = labour line).
- Customer-facing totals: paise precision retained. Display rounding to rupees only if the founder chooses "round to rupee" (then a `ROUNDING` line, ⚖️ GST rounding rules).
- Quantity × unit price: `round(qty × unit_price_paise)` half-up, checked by a DB constraint on quote items.

---

## 10. Payout process (weekly default)
1. **Build (scheduler, Monday 06:00 IST):** for each technician with an ACTIVE verified payout method not in cooling-off: available = payable − cash held − dispute holds − minimum payout threshold carry-over. Draft batch.
2. **Preview (finance maker):** totals, anomalies flagged (first payout to a new method, payout > 3× trailing average, recent method change, open fraud signal).
3. **Approve (finance checker ≠ maker, WebAuthn).**
4. **Execute:** per payout, submit with an idempotency key. Ledger submit posting. Status via webhook + polling.
5. **Notify** the technician (SMS/IVR/app): amount, last 4 digits, statement link/IVR summary.
6. **Failures:** method flagged, the technician is contacted through an agent, and funds stay in `TECH_PAYABLE` (never lost).
