// Gate 2 exit criterion: DB constraint tests green for INV-01, 05, 07, 10, 11, 12, 16, 19 at SQL level, plus the
// errata applied at Gate 2 (G-8, G-9, X-05, X-24, X-34, Q-C) and ledger L1-L4, L10. Runs as the schema owner (not a
// superuser): owner-bypassable grants don't matter here, so these tests prove the CHECKs / indexes / triggers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { createTestDatabase, inRollback, sqlState, sqlStateAtCommit, type TestDatabase } from '../../db-harness.ts';
import {
  approvalSql, assignment, billStatements, diagnosisVisit, draftVersion, hash32, job, ledgerTxn, platformAccounts, present, quote,
} from './builders.ts';

let db: TestDatabase;
const c = () => db.migrator;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});

describe('INV-01: at most one ACTIVE assignment per visit', () => {
  it('rejects a second ACTIVE assignment and allows one after release', () =>
    inRollback(c(), async () => {
      const v = await diagnosisVisit(c(), await job(c()));
      const first = await assignment(c(), v);
      expect(await sqlState(c(), `INSERT INTO jobs.assignments (id, visit_id, technician_user_id, offer_id, assigned_via, assigned_by_actor_type, assigned_by_actor_id, status)
                                  VALUES ($1, $2, $3, $4, 'CASCADE_OFFER', 'SYSTEM', $5, 'ACTIVE')`, [newId(), v, newId(), newId(), newId()])).toBe('23505');
      await c().query("UPDATE jobs.assignments SET status = 'RELEASED', ended_at = now() WHERE id = $1", [first]);
      await assignment(c(), v);
    }));
});

describe('INV-05: a quote version is immutable once PRESENTED', () => {
  it('rejects changes to a presented version and its items', () =>
    inRollback(c(), async () => {
      const q = await draftVersion(c(), await quote(c()), 1, [{ type: 'VISIT_FEE', amount: 19900 }, { type: 'LABOUR', amount: 50000 }]);
      await present(c(), q.versionId);
      expect(await sqlState(c(), 'UPDATE diagnosis.quote_versions SET items_total_paise = 1, total_payable_paise = 1 WHERE id = $1', [q.versionId])).toBe('HS002');
      expect(await sqlState(c(), 'UPDATE diagnosis.quote_versions SET content_hash = $2 WHERE id = $1', [q.versionId, hash32()])).toBe('HS002');
      expect(await sqlState(c(), 'DELETE FROM diagnosis.quote_versions WHERE id = $1', [q.versionId])).toBe('HS002');
      expect(await sqlState(c(), `INSERT INTO diagnosis.quote_items (id, quote_version_id, line_no, item_type, label_key, qty, unit_price_paise, amount_paise)
                                  VALUES ($1, $2, 9, 'LABOUR', 'x', 1, 5, 5)`, [newId(), q.versionId])).toBe('HS002');
      expect(await sqlState(c(), 'UPDATE diagnosis.quote_items SET label_key = $2 WHERE quote_version_id = $1', [q.versionId, 'changed'])).toBe('HS002');
      expect(await sqlState(c(), 'DELETE FROM diagnosis.quote_items WHERE quote_version_id = $1', [q.versionId])).toBe('HS002');
      expect(await sqlState(c(), "UPDATE diagnosis.quote_versions SET status = 'DRAFT' WHERE id = $1", [q.versionId])).toBe('HS003');
    }));

  it('rejects presenting a version whose totals do not match its items (G-8 sums)', () =>
    inRollback(c(), async () => {
      const q = await draftVersion(c(), await quote(c()), 1, [{ type: 'LABOUR', amount: 50000 }], { items_total_paise: 40000 });
      expect(await sqlState(c(), "UPDATE diagnosis.quote_versions SET status = 'PRESENTED', presented_at = now() WHERE id = $1", [q.versionId])).toBe('HS020');
    }));

  it('subtracts credit lines (VISIT_FEE_CREDIT, DISCOUNT) and keeps their amounts non-negative (G-8)', () =>
    inRollback(c(), async () => {
      const q = await draftVersion(c(), await quote(c()), 1, [
        { type: 'VISIT_FEE', amount: 19900 }, { type: 'LABOUR', amount: 50000 }, { type: 'VISIT_FEE_CREDIT', amount: 19900 }, { type: 'DISCOUNT', amount: 1000 },
      ]);
      await present(c(), q.versionId);
      const r = await c().query('SELECT total_payable_paise FROM diagnosis.quote_versions WHERE id = $1', [q.versionId]);
      expect(Number(r.rows[0].total_payable_paise)).toBe(19900 + 50000 - 19900 - 1000);
      const draft = await draftVersion(c(), await quote(c()), 1, [{ type: 'LABOUR', amount: 100 }]);
      expect(await sqlState(c(), `INSERT INTO diagnosis.quote_items (id, quote_version_id, line_no, item_type, label_key, qty, unit_price_paise, amount_paise)
                                  VALUES ($1, $2, 2, 'DISCOUNT', 'x', 1, 0, -5)`, [newId(), draft.versionId])).toBe('23514');
    }));
});

describe('INV-06 / INV-07: decisions and approvals', () => {
  it('records a decision only for the PRESENTED version with the hash the customer saw', () =>
    inRollback(c(), async () => {
      const q = await draftVersion(c(), await quote(c()), 1, [{ type: 'LABOUR', amount: 50000 }]);
      const onDraft = approvalSql(q.versionId, q.contentHash);
      expect(await sqlState(c(), onDraft.sql, onDraft.params)).toBe('HS020');
      await present(c(), q.versionId);
      const wrongHash = approvalSql(q.versionId, hash32());
      expect(await sqlState(c(), wrongHash.sql, wrongHash.params)).toBe('HS020');
      const ok = approvalSql(q.versionId, q.contentHash);
      expect(await sqlState(c(), ok.sql, ok.params)).toBe('OK');
      const again = approvalSql(q.versionId, q.contentHash);
      expect(await sqlState(c(), again.sql, again.params)).toBe('23505');
      expect(await sqlState(c(), "UPDATE diagnosis.quote_approvals SET decision = 'REJECTED' WHERE quote_version_id = $1", [q.versionId])).toBe('HS001');
    }));

  it('INV-07: at most one APPROVED version per quote', () =>
    inRollback(c(), async () => {
      const quoteId = await quote(c());
      const v1 = await draftVersion(c(), quoteId, 1, [{ type: 'LABOUR', amount: 100 }]);
      await present(c(), v1.versionId);
      await c().query("UPDATE diagnosis.quote_versions SET status = 'APPROVED', decided_at = now() WHERE id = $1", [v1.versionId]);
      const v2 = await draftVersion(c(), quoteId, 2, [{ type: 'LABOUR', amount: 200 }]);
      await present(c(), v2.versionId);
      expect(await sqlState(c(), "UPDATE diagnosis.quote_versions SET status = 'APPROVED', decided_at = now() WHERE id = $1", [v2.versionId])).toBe('23505');
      await c().query("UPDATE diagnosis.quote_versions SET status = 'SUPERSEDED' WHERE id = $1", [v1.versionId]);
      expect(await sqlState(c(), "UPDATE diagnosis.quote_versions SET status = 'APPROVED', decided_at = now() WHERE id = $1", [v2.versionId])).toBe('OK');
    }));
});

describe('G-9: separation of duties on ops-recorded approvals', () => {
  // A real PRESENTED version (with its hash) so the approval guard passes and the CHECK constraints decide.
  let target: { versionId: string; contentHash: Buffer };
  const opsApproval = (recorder: string, verifier: string, capturer: string | null) => ({
    sql: `INSERT INTO diagnosis.quote_approvals (id, quote_version_id, decision, content_hash, channel, customer_user_id, call_session_id,
            ops_recorder_admin_id, ops_verifier_admin_id, diagnosis_capturer_admin_id, repair_preference, preferred_technician_user_id)
          VALUES ($1, $2, 'APPROVED', $3, 'OPS_RECORDED_CALL', $4, $5, $6, $7, $8, 'SAME_TECHNICIAN', $9)`,
    params: [newId(), target.versionId, target.contentHash, newId(), newId(), recorder, verifier, capturer, newId()],
  });

  it('rejects recorder = verifier and capturer = recorder / verifier', () =>
    inRollback(c(), async () => {
      target = await draftVersion(c(), await quote(c()), 1, [{ type: 'LABOUR', amount: 100 }]);
      await present(c(), target.versionId);
      const a = newId();
      const b = newId();
      const ok = opsApproval(a, b, newId());
      expect(await sqlState(c(), ok.sql, ok.params)).toBe('OK');
      // CHECK constraints are evaluated before the one-decision-per-version unique index, so these report 23514.
      const s1 = opsApproval(a, a, null);
      expect(await sqlState(c(), s1.sql, s1.params)).toBe('23514');
      const s2 = opsApproval(a, b, a);
      expect(await sqlState(c(), s2.sql, s2.params)).toBe('23514');
      const s3 = opsApproval(a, b, b);
      expect(await sqlState(c(), s3.sql, s3.params)).toBe('23514');
    }));
});

describe('INV-10: invoices equal the bill lines at issue and are immutable', () => {
  it('rejects a mismatching invoice, accepts a matching one, rejects later changes', () =>
    inRollback(c(), async () => {
      const bill = billStatements([{ type: 'VISIT_FEE', amount: 19900 }, { type: 'LABOUR', amount: 50000 }]);
      for (const s of bill.statements) await c().query(s.sql, s.params);
      const series = newId();
      await c().query("INSERT INTO payments.invoice_series (id, issuer_key, fiscal_year, prefix) VALUES ($1, 'PLATFORM', '2026-27', 'TST')", [series]);
      const invoice = (lines: unknown[], total: number, no: string) => ({
        sql: `INSERT INTO payments.invoices (id, series_id, invoice_number, kind, bill_id, job_id, issuer_type, lines, taxable_paise, tax_paise, total_paise)
              VALUES ($1, $2, $3, 'INVOICE', $4, $5, 'PLATFORM', $6, $7, 0, $7)`,
        params: [newId(), series, no, bill.billId, newId(), JSON.stringify(lines), total],
      });
      const good = [{ line_no: 1, line_type: 'VISIT_FEE', amount_paise: 19900 }, { line_no: 2, line_type: 'LABOUR', amount_paise: 50000 }];
      const bad = invoice([{ line_no: 1, line_type: 'VISIT_FEE', amount_paise: 19900 }], 19900, 'TST-1');
      expect(await sqlState(c(), bad.sql, bad.params)).toBe('HS020');
      const ok = invoice(good, 69900, 'TST-2');
      expect(await sqlState(c(), ok.sql, ok.params)).toBe('OK');
      expect(await sqlState(c(), "UPDATE payments.invoices SET total_paise = 1, taxable_paise = 1 WHERE invoice_number = 'TST-2'")).toBe('HS001');
      expect(await sqlState(c(), "DELETE FROM payments.invoices WHERE invoice_number = 'TST-2'")).toBe('HS001');
    }));
});

describe('G-8: bill totals and credit lines', () => {
  it('a bill amount due must equal the signed sum of its lines (checked at commit)', () =>
    inRollback(c(), async () => {
      const mismatch = billStatements([{ type: 'LABOUR', amount: 50000 }], { amountDue: 40000 });
      expect(await sqlStateAtCommit(c(), mismatch.statements)).toBe('HS020');
      const noLines = billStatements([], { amountDue: 100 });
      expect(await sqlStateAtCommit(c(), noLines.statements)).toBe('HS020');
      const ok = billStatements([{ type: 'LABOUR', amount: 50000 }, { type: 'DISCOUNT', amount: -5000 }]);
      expect(await sqlStateAtCommit(c(), ok.statements)).toBe('OK');
    }));

  it('credit line types must be negative; others non-negative; prior credit needs prior_bill_id', () =>
    inRollback(c(), async () => {
      expect(await sqlStateAtCommit(c(), billStatements([{ type: 'LABOUR', amount: 100 }, { type: 'DISCOUNT', amount: 10 }]).statements)).toBe('23514');
      expect(await sqlStateAtCommit(c(), billStatements([{ type: 'LABOUR', amount: -100 }]).statements)).toBe('23514');
      expect(await sqlStateAtCommit(c(), billStatements([{ type: 'LABOUR', amount: 100 }, { type: 'PRIOR_PAYMENT_CREDIT', amount: -10 }]).statements)).toBe('23514');
    }));

  it('a prior-payment credit never exceeds what the prior bill settled', () =>
    inRollback(c(), async () => {
      const jobId = newId();
      const prior = billStatements([{ type: 'VISIT_FEE', amount: 19900 }], { jobId, billNo: 1 });
      for (const s of prior.statements) await c().query(s.sql, s.params);
      await c().query("UPDATE payments.bills SET amount_settled_paise = 19900, status = 'PAID', settled_at = now() WHERE id = $1", [prior.billId]);
      const tooMuch = billStatements([{ type: 'LABOUR', amount: 50000 }, { type: 'PRIOR_PAYMENT_CREDIT', amount: -20000, priorBillId: prior.billId }], { jobId, billNo: 2 });
      expect(await sqlStateAtCommit(c(), tooMuch.statements)).toBe('HS020');
      const ok = billStatements([{ type: 'LABOUR', amount: 50000 }, { type: 'PRIOR_PAYMENT_CREDIT', amount: -19900, priorBillId: prior.billId }], { jobId, billNo: 3 });
      expect(await sqlStateAtCommit(c(), ok.statements)).toBe('OK');
    }));

  it('issued bill fields are immutable, lines cannot be added to a settled bill, bills are never deleted', () =>
    inRollback(c(), async () => {
      const b = billStatements([{ type: 'LABOUR', amount: 1000 }]);
      for (const s of b.statements) await c().query(s.sql, s.params);
      expect(await sqlState(c(), 'UPDATE payments.bills SET amount_due_paise = 1 WHERE id = $1', [b.billId])).toBe('HS002');
      expect(await sqlState(c(), 'DELETE FROM payments.bills WHERE id = $1', [b.billId])).toBe('HS002');
      await c().query("UPDATE payments.bills SET amount_settled_paise = 1000, status = 'PAID', settled_at = now() WHERE id = $1", [b.billId]);
      expect(await sqlState(c(), `INSERT INTO payments.bill_lines (id, bill_id, line_no, line_type, label_key, amount_paise) VALUES ($1, $2, 9, 'LABOUR', 'x', 5)`,
        [newId(), b.billId])).toBe('HS002');
      expect(await sqlState(c(), 'UPDATE payments.bill_lines SET amount_paise = 1 WHERE bill_id = $1', [b.billId])).toBe('HS001');
    }));
});

describe('INV-11 / ledger L1-L4, L10', () => {
  it('L1: unbalanced or single-entry transactions fail at commit; balanced ones commit', () =>
    inRollback(c(), async () => {
      const a = await platformAccounts(c());
      const unbalanced = ledgerTxn([{ account: a.bank, direction: 'DEBIT', amount: 100 }, { account: a.revenue, direction: 'CREDIT', amount: 90 }]);
      expect(await sqlStateAtCommit(c(), unbalanced.statements)).toBe('HS010');
      const single = ledgerTxn([{ account: a.bank, direction: 'DEBIT', amount: 100 }]);
      expect(await sqlStateAtCommit(c(), single.statements)).toBe('HS010');
      const empty = ledgerTxn([]);
      expect(await sqlStateAtCommit(c(), empty.statements)).toBe('HS010');
      const ok = ledgerTxn([{ account: a.bank, direction: 'DEBIT', amount: 100 }, { account: a.revenue, direction: 'CREDIT', amount: 100 }]);
      expect(await sqlStateAtCommit(c(), ok.statements)).toBe('OK');
    }));

  it('L2: ledger rows are never updated or deleted', () =>
    inRollback(c(), async () => {
      const a = await platformAccounts(c());
      const t = ledgerTxn([{ account: a.bank, direction: 'DEBIT', amount: 100 }, { account: a.revenue, direction: 'CREDIT', amount: 100 }]);
      for (const s of t.statements) await c().query(s.sql, s.params);
      expect(await sqlState(c(), 'UPDATE ledger.entries SET amount_paise = 1 WHERE transaction_id = $1', [t.txnId])).toBe('HS001');
      expect(await sqlState(c(), 'DELETE FROM ledger.entries WHERE transaction_id = $1', [t.txnId])).toBe('HS001');
      expect(await sqlState(c(), "UPDATE ledger.transactions SET reason_code = 'x' WHERE id = $1", [t.txnId])).toBe('HS001');
      expect(await sqlState(c(), 'DELETE FROM ledger.transactions WHERE id = $1', [t.txnId])).toBe('HS001');
    }));

  it('L3: one transaction per business event (idempotency key)', () =>
    inRollback(c(), async () => {
      const a = await platformAccounts(c());
      const entries = [{ account: a.bank, direction: 'DEBIT' as const, amount: 5 }, { account: a.revenue, direction: 'CREDIT' as const, amount: 5 }];
      for (const s of ledgerTxn(entries, { key: 'payment:sandbox:p1:capture' }).statements) await c().query(s.sql, s.params);
      const [dupTxn] = ledgerTxn(entries, { key: 'payment:sandbox:p1:capture' }).statements;
      expect(await sqlState(c(), dupTxn?.sql ?? '', dupTxn?.params)).toBe('23505');
    }));

  it('L4: a reversal must mirror its original exactly; at most one reversal per original', () =>
    inRollback(c(), async () => {
      const a = await platformAccounts(c());
      const original = ledgerTxn([{ account: a.bank, direction: 'DEBIT', amount: 700 }, { account: a.revenue, direction: 'CREDIT', amount: 700 }]);
      expect(await sqlStateAtCommit(c(), original.statements)).toBe('OK');
      const wrong = ledgerTxn([{ account: a.bank, direction: 'CREDIT', amount: 500 }, { account: a.revenue, direction: 'DEBIT', amount: 500 }], { reverses: original.txnId });
      expect(await sqlStateAtCommit(c(), wrong.statements)).toBe('HS010');
      const mirror = ledgerTxn([{ account: a.bank, direction: 'CREDIT', amount: 700 }, { account: a.revenue, direction: 'DEBIT', amount: 700 }], { reverses: original.txnId });
      expect(await sqlStateAtCommit(c(), mirror.statements)).toBe('OK');
      const second = ledgerTxn([{ account: a.bank, direction: 'CREDIT', amount: 700 }, { account: a.revenue, direction: 'DEBIT', amount: 700 }], { reverses: original.txnId });
      expect(await sqlStateAtCommit(c(), second.statements)).toBe('23505');
    }));

  it('L10 / INV-28: no forbidden (customer stored-value) account subtype; owners required for per-owner accounts', () =>
    inRollback(c(), async () => {
      expect(await sqlState(c(), "INSERT INTO ledger.accounts (id, code, account_type, subtype) VALUES ($1, 'CUSTOMER_WALLET:x', 'LIABILITY', 'CUSTOMER_WALLET')", [newId()])).toBe('23514');
      expect(await sqlState(c(), "INSERT INTO ledger.accounts (id, code, account_type, subtype) VALUES ($1, 'TECH_PAYABLE:x', 'LIABILITY', 'TECH_PAYABLE')", [newId()])).toBe('23514');
      expect(await sqlState(c(), "INSERT INTO ledger.accounts (id, code, account_type, subtype, owner_type) VALUES ($1, 'SUSPENSE2', 'ASSET', 'SUSPENSE', 'PLATFORM')", [newId()])).toBe('23514');
    }));
});

describe('INV-12: refunds never exceed captured minus chargebacks lost', () => {
  it('rejects an over-refund and an inconsistent payment row', () =>
    inRollback(c(), async () => {
      const b = billStatements([{ type: 'LABOUR', amount: 10000 }]);
      for (const s of b.statements) await c().query(s.sql, s.params);
      const payment = newId();
      await c().query(
        `INSERT INTO payments.payments (id, bill_id, method, provider, provider_payment_id, amount_paise, chargeback_lost_paise, status, captured_at, ledger_txn_id)
         VALUES ($1, $2, 'UPI', 'sandbox', $3, 10000, 2000, 'CAPTURED', now(), $4)`,
        [payment, b.billId, `pay_${payment}`, newId()],
      );
      const refund = (amount: number) => ({
        sql: `INSERT INTO payments.refunds (id, payment_id, amount_paise, reason_code, bearer, destination, status, requested_by_admin_id, idempotency_key)
              VALUES ($1, $2, $3, 'GOODWILL', 'PLATFORM', 'SOURCE', 'REQUESTED', $4, $5)`,
        params: [newId(), payment, amount, newId(), `refund:${newId()}`],
      });
      const r1 = refund(6000);
      expect(await sqlState(c(), r1.sql, r1.params)).toBe('OK');
      const r2 = refund(2001);
      expect(await sqlState(c(), r2.sql, r2.params)).toBe('HS020');
      const r3 = refund(2000);
      expect(await sqlState(c(), r3.sql, r3.params)).toBe('OK');
      expect(await sqlState(c(), 'UPDATE payments.payments SET refunded_paise = 9000 WHERE id = $1', [payment])).toBe('23514');
    }));
});

describe('INV-16: one rating per (job, rater, ratee, direction)', () => {
  it('rejects a duplicate rating', () =>
    inRollback(c(), async () => {
      const [jobId, rater, ratee] = [newId(), newId(), newId()];
      const rating = () => ({
        sql: `INSERT INTO trust.ratings (id, job_id, rater_user_id, ratee_user_id, direction, stars, editable_until)
              VALUES ($1, $2, $3, $4, 'CUSTOMER_TO_TECHNICIAN', 5, now() + interval '1 day')`,
        params: [newId(), jobId, rater, ratee],
      });
      const first = rating();
      expect(await sqlState(c(), first.sql, first.params)).toBe('OK');
      const dup = rating();
      expect(await sqlState(c(), dup.sql, dup.params)).toBe('23505');
    }));
});

describe('INV-19: maker != checker', () => {
  it('rejects an approval decided by its own requester', () =>
    inRollback(c(), async () => {
      const admin = newId();
      expect(await sqlState(c(),
        `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, payload, payload_hash, risk_level, requested_by_admin_id,
           required_approver_permission, decided_by_admin_id, decided_at, status, expires_at)
         VALUES ($1, 'REFUND', 'payment', '{}', $2, 'HIGH', $3, 'refund.approve', $3, now(), 'APPROVED', now() + interval '1 day')`,
        [newId(), hash32(), admin])).toBe('23514');
    }));
});

describe('errata columns: X-05, X-24, X-34, Q-C, INV-24, INV-22', () => {
  it('X-05: users.preferred_locale has no default', () =>
    inRollback(c(), async () => {
      expect(await sqlState(c(), "INSERT INTO identity.users (id, phone_enc, phone_bidx, status) VALUES ($1, '\\x01', $2, 'ACTIVE')",
        [newId(), Buffer.alloc(16, 1)])).toBe('23502');
    }));

  it('X-24 / X-34: payment preference and on-site adult are required, closed sets', () =>
    inRollback(c(), async () => {
      expect(await sqlState(c(), 'UPDATE jobs.jobs SET payment_preference = $1 WHERE id = $2', ['CREDIT', await job(c())])).toBe('23514');
      expect(await sqlState(c(), 'UPDATE jobs.jobs SET onsite_adult = NULL WHERE id = $1', [await job(c())])).toBe('23502');
      expect(await sqlState(c(), 'UPDATE jobs.jobs SET onsite_adult = $1 WHERE id = $2', ['NOBODY', await job(c())])).toBe('23514');
    }));

  it('Q-C: preferred_language is optional and limited to te / en / other', () =>
    inRollback(c(), async () => {
      expect(await sqlState(c(), "INSERT INTO customers.customer_profiles (user_id, preferred_locale) VALUES ($1, 'te-IN')", [newId()])).toBe('OK');
      expect(await sqlState(c(), "INSERT INTO customers.customer_profiles (user_id, preferred_locale, preferred_language) VALUES ($1, 'te-IN', 'hi')", [newId()])).toBe('23514');
    }));

  it('INV-24: recorded cash must equal the amount due', () =>
    inRollback(c(), async () => {
      const b = billStatements([{ type: 'LABOUR', amount: 1000 }]);
      for (const s of b.statements) await c().query(s.sql, s.params);
      expect(await sqlState(c(),
        `INSERT INTO payments.cash_collections (id, bill_id, visit_id, technician_user_id, amount_paise, amount_due_at_record_paise, recorded_channel, customer_confirmation)
         VALUES ($1, $2, $3, $4, 900, 1000, 'IVR', 'PENDING')`, [newId(), b.billId, newId(), newId()])).toBe('23514');
    }));

  it('INV-22: a warranty coverage is an immutable snapshot (status may only expire / void)', () =>
    inRollback(c(), async () => {
      const policy = newId();
      await c().query(
        `INSERT INTO warranty.warranty_policies (id, code, version_no, scope_type, scope_id, duration_days, cost_bearer, status, effective)
         VALUES ($1, 'WP-T', 1, 'REPAIR_ITEM', $2, 30, 'ORIGINAL_TECHNICIAN', 'ACTIVE', tstzrange(now(), NULL))`, [policy, newId()]);
      const coverage = newId();
      await c().query(
        `INSERT INTO warranty.warranty_coverages (id, job_id, repair_order_id, customer_user_id, policy_id, policy_snapshot, covered_repair_item_ids,
           original_technician_user_ids, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4, $5, '{"duration_days":30}', ARRAY[$6::uuid], ARRAY[$7::uuid], now(), now() + interval '30 days', 'ACTIVE')`,
        [coverage, newId(), newId(), newId(), policy, newId(), newId()]);
      expect(await sqlState(c(), `UPDATE warranty.warranty_coverages SET policy_snapshot = '{}' WHERE id = $1`, [coverage])).toBe('HS002');
      expect(await sqlState(c(), `UPDATE warranty.warranty_coverages SET ends_at = ends_at + interval '1 year' WHERE id = $1`, [coverage])).toBe('HS002');
      expect(await sqlState(c(), `DELETE FROM warranty.warranty_coverages WHERE id = $1`, [coverage])).toBe('HS002');
      expect(await sqlState(c(), `UPDATE warranty.warranty_coverages SET status = 'EXPIRED' WHERE id = $1`, [coverage])).toBe('OK');
      expect(await sqlState(c(), `UPDATE warranty.warranty_coverages SET status = 'ACTIVE' WHERE id = $1`, [coverage])).toBe('HS003');
    }));
});

describe('diagnoses are immutable once submitted', () => {
  it('rejects edits and new items after submission', () =>
    inRollback(c(), async () => {
      const id = newId();
      await c().query(
        `INSERT INTO diagnosis.diagnoses (id, job_id, visit_id, technician_user_id, captured_by_actor_type, captured_by_actor_id, kind, problem_code,
           severity, required_repair_service_type_id, same_visit_feasible, material_available_now, status)
         VALUES ($1, $2, $3, $4, 'TECHNICIAN', $4, 'INITIAL', 'NOT_COOLING', 'MODERATE', $5, false, false, 'DRAFT')`,
        [id, newId(), newId(), newId(), newId()]);
      const item = () => ({
        sql: "INSERT INTO diagnosis.diagnosis_items (id, diagnosis_id, line_type, repair_item_id, qty) VALUES ($1, $2, 'REPAIR_ITEM', $3, 1)",
        params: [newId(), id, newId()],
      });
      const draftItem = item();
      expect(await sqlState(c(), draftItem.sql, draftItem.params)).toBe('OK');
      await c().query("UPDATE diagnosis.diagnoses SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1", [id]);
      expect(await sqlState(c(), "UPDATE diagnosis.diagnoses SET severity = 'MINOR' WHERE id = $1", [id])).toBe('HS002');
      const lateItem = item();
      expect(await sqlState(c(), lateItem.sql, lateItem.params)).toBe('HS002');
      expect(await sqlState(c(), 'DELETE FROM diagnosis.diagnosis_items WHERE diagnosis_id = $1', [id])).toBe('HS002');
      expect(await sqlState(c(), "UPDATE diagnosis.diagnoses SET status = 'VOIDED', voided_reason_code = 'DUPLICATE' WHERE id = $1", [id])).toBe('OK');
    }));
});

describe('price snapshots are immutable (INV-21)', () => {
  it('rejects updates and deletes', () =>
    inRollback(c(), async () => {
      const card = newId();
      await c().query("INSERT INTO pricing.rate_cards (id, city_id, version_no, label, status, created_by_admin_id) VALUES ($1, $2, 1, 'TEST', 'DRAFT', $3)", [card, newId(), newId()]);
      const snap = newId();
      await c().query("INSERT INTO pricing.price_snapshots (id, rate_card_id, rule_refs, inputs, outputs, engine_version, content_hash) VALUES ($1, $2, '{}', '{}', '{}', 't', $3)",
        [snap, card, hash32()]);
      expect(await sqlState(c(), "UPDATE pricing.price_snapshots SET outputs = '{\"x\":1}' WHERE id = $1", [snap])).toBe('HS001');
      expect(await sqlState(c(), 'DELETE FROM pricing.price_snapshots WHERE id = $1', [snap])).toBe('HS001');
    }));
});
