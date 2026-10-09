// Gate 2 exit criterion: append-only UPDATE / DELETE rejected (03 §12.2) - by trigger, even for the table owner, and
// on every partition of partitioned tables.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { createTestDatabase, inRollback, sqlState, type TestDatabase } from '../../db-harness.ts';

// 03 §12.2 list as built in Gate 2 (+ immutable records from 03 §14.4). verification_records,
// trust.safety_incident_events and voice.ivr_interactions are created with their gates and join this list then.
// Gate 5 (0033): the transition table and the assignment history.
const EXPECTED = [
  'compliance.audit_logs', 'compliance.consent_events', 'compliance.disclosure_events', 'diagnosis.quote_approvals',
  'jobs.allowed_transitions', 'jobs.assignment_status_history',
  'jobs.job_cancellations', 'jobs.job_status_history', 'jobs.repair_order_status_history', 'jobs.visit_presence_proofs',
  'jobs.visit_status_history', 'ledger.accounts', 'ledger.entries', 'ledger.transactions', 'payments.bill_lines',
  'payments.invoices', 'pricing.price_snapshots', 'workforce.technician_daily_checkins',
];

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});

describe('append-only tables', () => {
  it('carry the row and truncate triggers (exact list)', async () => {
    const r = await db.admin.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name,
              bool_or(t.tgname = 'append_only_rows' AND p.proname = 'reject_mutation'
                      AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16) AS row_guard,
              bool_or(t.tgname = 'append_only_truncate') AS truncate_guard
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgname IN ('append_only_rows', 'append_only_truncate') AND NOT c.relispartition
        GROUP BY 1 ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.name as string).sort()).toEqual([...EXPECTED].sort());
    for (const row of r.rows) expect(row, row.name).toMatchObject({ row_guard: true, truncate_guard: true });
  });

  it('every partition of an append-only partitioned table has the guard too', async () => {
    const r = await db.admin.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS partition,
              EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'append_only_rows') AS guarded
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent IN ('compliance.audit_logs'::regclass, 'compliance.disclosure_events'::regclass, 'jobs.job_status_history'::regclass,
                              'jobs.visit_status_history'::regclass, 'jobs.repair_order_status_history'::regclass,
                              'jobs.assignment_status_history'::regclass)`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(25);
    for (const row of r.rows) expect(row.guarded, row.partition).toBe(true);
  });

  it('TRUNCATE is refused for every append-only table, even for the owner', async () => {
    for (const table of EXPECTED) {
      const state = await inRollback(db.migrator, () => sqlState(db.migrator, `TRUNCATE ${table}`));
      // HS001 = our guard; 0A000 = PostgreSQL refuses first because other tables reference this one. Both refuse.
      expect(['HS001', '0A000'], table).toContain(state);
    }
  });

  it('rejects UPDATE and DELETE on real rows (owner connection), including via a partition directly', () =>
    inRollback(db.migrator, async () => {
      const consent = newId();
      await db.migrator.query(
        `INSERT INTO compliance.consent_events (id, user_id, purpose, action, notice_id, notice_version, locale, channel, evidence)
         VALUES ($1, $2, 'SERVICE_DELIVERY', 'GRANTED', $3, 'v1', 'te-IN', 'PWA', '{"session_id":"x"}')`,
        [consent, newId(), newId()],
      );
      expect(await sqlState(db.migrator, "UPDATE compliance.consent_events SET action = 'WITHDRAWN' WHERE id = $1", [consent])).toBe('HS001');
      expect(await sqlState(db.migrator, 'DELETE FROM compliance.consent_events WHERE id = $1', [consent])).toBe('HS001');

      const audit = newId();
      await db.migrator.query(
        `INSERT INTO compliance.audit_logs (id, actor_type, action, resource_type, outcome, chain_partition, prev_hash, row_hash)
         VALUES ($1, 'SYSTEM', 'test.event', 'test', 'SUCCESS', 'test', $2, $2)`,
        [audit, Buffer.alloc(32, 7)],
      );
      const part = await db.migrator.query('SELECT tableoid::regclass::text AS p FROM compliance.audit_logs WHERE id = $1', [audit]);
      const partition = part.rows[0].p as string;
      expect(partition).toMatch(/^compliance\.audit_logs_p\d{6}$/);
      expect(await sqlState(db.migrator, "UPDATE compliance.audit_logs SET outcome = 'DENIED' WHERE id = $1", [audit])).toBe('HS001');
      expect(await sqlState(db.migrator, `DELETE FROM ${partition} WHERE id = $1`, [audit])).toBe('HS001');
    }));
});
