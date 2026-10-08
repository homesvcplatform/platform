// Minimal valid rows for invariant tests. Every builder runs inside the caller's (rolled-back) transaction.
// Cross-schema references are plain UUIDs (Phase 1 03 §1: no cross-schema FKs), so they can be random here.
import { randomBytes, randomInt } from 'node:crypto';
import type pg from 'pg';
import { newId } from '@hsp/kernel';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const hash32 = (): Buffer => randomBytes(32);
const publicRef = () => `J-${Array.from({ length: 7 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join('')}`;

export async function priceSnapshot(c: pg.Client): Promise<string> {
  const card = newId();
  await c.query(
    `INSERT INTO pricing.rate_cards (id, city_id, version_no, label, status, created_by_admin_id)
     VALUES ($1, $2, 1, 'TEST_CARD', 'DRAFT', $3)`,
    [card, newId(), newId()],
  );
  const snap = newId();
  await c.query(
    `INSERT INTO pricing.price_snapshots (id, rate_card_id, rule_refs, inputs, outputs, engine_version, content_hash)
     VALUES ($1, $2, '{}', '{}', '{}', 'test', $3)`,
    [snap, card, hash32()],
  );
  return snap;
}

export async function job(c: pg.Client, overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: newId(), public_ref: publicRef(), customer_user_id: newId(), city_id: newId(), zone_id: newId(), locality_id: newId(),
    service_type_id: newId(), address_id: newId(), address_snapshot_enc: randomBytes(24), channel: 'PWA',
    payment_preference: 'EITHER', onsite_adult: 'SELF', created_by_actor_type: 'CUSTOMER', created_by_actor_id: newId(),
    customer_verified: true, client_request_id: newId(), status: 'REQUESTED', visit_fee_snapshot_id: newId(),
    ...overrides,
  };
  const cols = Object.keys(row);
  await c.query(`INSERT INTO jobs.jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return row['id'] as string;
}

export async function diagnosisVisit(c: pg.Client, jobId: string, sequenceNo = 1): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO jobs.visits (id, job_id, city_id, locality_id, sequence_no, purposes, required_service_type_id, required_capability,
       service_window, urgency, status, start_code_hash, visit_code)
     VALUES ($1, $2, $3, $4, $5, '{DIAGNOSIS}', $6, 'DIAGNOSE', tstzrange(now(), now() + interval '1 hour'), 'ASAP', 'PLANNED', $7, '1234')`,
    [id, jobId, newId(), newId(), sequenceNo, newId(), hash32()],
  );
  return id;
}

export async function assignment(c: pg.Client, visitId: string, status = 'ACTIVE'): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO jobs.assignments (id, visit_id, technician_user_id, offer_id, assigned_via, assigned_by_actor_type, assigned_by_actor_id, status, ended_at)
     VALUES ($1, $2, $3, $4, 'CASCADE_OFFER', 'SYSTEM', $5, $6, CASE WHEN $6 = 'ACTIVE' THEN NULL ELSE now() END)`,
    [id, visitId, newId(), newId(), newId(), status],
  );
  return id;
}

export interface QuoteItemSpec {
  type: 'VISIT_FEE' | 'VISIT_FEE_CREDIT' | 'LABOUR' | 'MATERIAL' | 'PLATFORM_FEE' | 'DISCOUNT' | 'TAX';
  amount: number;
}

export interface DraftQuote {
  quoteId: string;
  versionId: string;
  contentHash: Buffer;
}

export async function quote(c: pg.Client): Promise<string> {
  const id = newId();
  await c.query('INSERT INTO diagnosis.quotes (id, job_id) VALUES ($1, $2)', [id, newId()]);
  return id;
}

/** A DRAFT version whose stored totals match its items (or `totalsOverride` to make them not match). */
export async function draftVersion(
  c: pg.Client, quoteId: string, versionNo: number, items: QuoteItemSpec[], totalsOverride?: Partial<Record<string, number>>,
): Promise<DraftQuote> {
  const sum = (types: string[]) => items.filter((i) => types.includes(i.type)).reduce((s, i) => s + i.amount, 0);
  const totals = {
    items_total_paise: sum(['VISIT_FEE', 'LABOUR', 'MATERIAL', 'PLATFORM_FEE']),
    discount_paise: sum(['DISCOUNT']),
    visit_fee_credit_paise: sum(['VISIT_FEE_CREDIT']),
    tax_paise: sum(['TAX']),
    ...totalsOverride,
  };
  const total = (totals.items_total_paise ?? 0) - (totals.discount_paise ?? 0) - (totals.visit_fee_credit_paise ?? 0) + (totals.tax_paise ?? 0);
  const versionId = newId();
  const contentHash = hash32();
  await c.query(
    `INSERT INTO diagnosis.quote_versions (id, quote_id, version_no, diagnosis_ids, created_by_actor_type, created_by_actor_id, price_snapshot_id,
       items_total_paise, discount_paise, visit_fee_credit_paise, tax_paise, total_payable_paise, technician_earnings_paise, content_hash, status)
     VALUES ($1, $2, $3, ARRAY[$4::uuid], 'TECHNICIAN', $5, $6, $7, $8, $9, $10, $11, 0, $12, 'DRAFT')`,
    [versionId, quoteId, versionNo, newId(), newId(), newId(), totals.items_total_paise, totals.discount_paise,
     totals.visit_fee_credit_paise, totals.tax_paise, total, contentHash],
  );
  for (const [i, item] of items.entries()) {
    await c.query(
      `INSERT INTO diagnosis.quote_items (id, quote_version_id, line_no, item_type, label_key, qty, unit_price_paise, amount_paise, material_id)
       VALUES ($1, $2, $3, $4, 'test.line', 1, $5, $5, $6)`,
      [newId(), versionId, i + 1, item.type, item.amount, item.type === 'MATERIAL' ? newId() : null],
    );
  }
  return { quoteId, versionId, contentHash };
}

export async function present(c: pg.Client, versionId: string): Promise<void> {
  await c.query("UPDATE diagnosis.quote_versions SET status = 'PRESENTED', presented_at = now() WHERE id = $1", [versionId]);
}

export function approvalSql(versionId: string, contentHash: Buffer): Statement {
  return {
    sql: `INSERT INTO diagnosis.quote_approvals (id, quote_version_id, decision, content_hash, channel, customer_user_id, session_id, repair_preference)
          VALUES ($1, $2, 'APPROVED', $3, 'APP_SESSION', $4, $5, 'SAME_VISIT')`,
    params: [newId(), versionId, contentHash, newId(), newId()],
  };
}

export interface Statement {
  sql: string;
  params: unknown[];
}

export interface BillLineSpec {
  type: string;
  amount: number;
  priorBillId?: string;
}

/** Inserts a bill and its lines (bill total checks run at commit / SET CONSTRAINTS IMMEDIATE). */
export function billStatements(
  lines: BillLineSpec[], opts: { amountDue?: number; billId?: string; billNo?: number; jobId?: string } = {},
): { billId: string; statements: Statement[] } {
  const billId = opts.billId ?? newId();
  const due = opts.amountDue ?? lines.reduce((s, l) => s + l.amount, 0);
  return {
    billId,
    statements: [
      {
        sql: `INSERT INTO payments.bills (id, job_id, bill_no, kind, price_snapshot_id, amount_due_paise, status)
              VALUES ($1, $2, $3, 'VISIT_FEE', $4, $5, 'OPEN')`,
        params: [billId, opts.jobId ?? newId(), opts.billNo ?? 1, newId(), due],
      },
      ...lines.map((l, i) => ({
        sql: `INSERT INTO payments.bill_lines (id, bill_id, line_no, line_type, prior_bill_id, label_key, amount_paise)
              VALUES ($1, $2, $3, $4, $5, 'test.line', $6)`,
        params: [newId(), billId, i + 1, l.type, l.priorBillId ?? null, l.amount],
      })),
    ],
  };
}

export async function platformAccounts(c: pg.Client): Promise<{ bank: string; suspense: string; revenue: string }> {
  const bank = newId();
  const suspense = newId();
  const revenue = newId();
  await c.query(
    `INSERT INTO ledger.accounts (id, code, account_type, subtype, owner_type) VALUES
       ($1, 'BANK_SETTLEMENT', 'ASSET', 'BANK_SETTLEMENT', 'PLATFORM'),
       ($2, 'SUSPENSE', 'LIABILITY', 'SUSPENSE', 'PLATFORM'),
       ($3, 'REV_VISIT_FEE', 'REVENUE', 'REV_VISIT_FEE', 'PLATFORM')`,
    [bank, suspense, revenue],
  );
  return { bank, suspense, revenue };
}

export function ledgerTxn(
  entries: { account: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[], opts: { reverses?: string; key?: string; id?: string } = {},
): { txnId: string; statements: Statement[] } {
  const txnId = opts.id ?? newId();
  return {
    txnId,
    statements: [
      {
        sql: `INSERT INTO ledger.transactions (id, txn_type, idempotency_key, reference_type, reference_id, reverses_txn_id, effective_at, created_by_actor_type)
              VALUES ($1, 'TEST', $2, 'TEST', $3, $4, now(), 'SYSTEM')`,
        params: [txnId, opts.key ?? `test:${txnId}`, newId(), opts.reverses ?? null],
      },
      ...entries.map((e) => ({
        sql: 'INSERT INTO ledger.entries (transaction_id, account_id, direction, amount_paise) VALUES ($1, $2, $3, $4)',
        params: [txnId, e.account, e.direction, e.amount],
      })),
    ],
  };
}
