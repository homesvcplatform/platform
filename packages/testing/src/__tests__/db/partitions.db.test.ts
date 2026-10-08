// Partition templates (03 §14.8): monthly partitions from last month to three months ahead, maintained idempotently.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { createTestDatabase, inRollback, sqlState, type TestDatabase } from '../../db-harness.ts';

const PARTITIONED = [
  'compliance.audit_logs', 'compliance.disclosure_events', 'jobs.job_status_history', 'jobs.repair_order_status_history',
  'jobs.visit_status_history', 'payments.provider_events',
];

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});

function expectedSuffixes(): string[] {
  const now = new Date();
  return [-1, 0, 1, 2, 3].map((m) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

describe('monthly partitions', () => {
  it('exist for last month through three months ahead on every partitioned table', async () => {
    for (const parent of PARTITIONED) {
      const r = await db.admin.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`, [parent],
      );
      const table = parent.split('.')[1] ?? '';
      expect(r.rows.map((x) => x.relname), parent).toEqual(expectedSuffixes().map((s) => `${table}_p${s}`));
    }
  });

  it('maintenance is idempotent', async () => {
    const r = await db.migrator.query("SELECT platform.ensure_monthly_partitions('compliance.audit_logs', 1, 3) AS created");
    expect(r.rows[0].created).toBe(0);
  });

  it('routes rows to the current month and refuses rows outside the created range', () =>
    inRollback(db.migrator, async () => {
      const id = newId();
      await db.migrator.query(
        `INSERT INTO jobs.job_status_history (id, job_id, to_status, actor_type, channel, correlation_id) VALUES ($1, $2, 'REQUESTED', 'SYSTEM', 'TEST', $3)`,
        [id, newId(), newId()],
      );
      const r = await db.migrator.query('SELECT tableoid::regclass::text AS p FROM jobs.job_status_history WHERE id = $1', [id]);
      expect(r.rows[0].p).toBe(`jobs.job_status_history_p${expectedSuffixes()[1]}`);
      expect(await sqlState(db.migrator,
        `INSERT INTO jobs.job_status_history (id, job_id, to_status, actor_type, channel, correlation_id, created_at)
         VALUES ($1, $2, 'REQUESTED', 'SYSTEM', 'TEST', $3, '2099-01-01T00:00:00Z')`, [newId(), newId(), newId()])).toBe('23514');
    }));

  it('runtime roles cannot create partitions (maintenance belongs to the owner / scheduler)', async () => {
    const r = await db.admin.query("SELECT has_function_privilege('app_worker', 'platform.ensure_monthly_partitions(regclass,int,int)', 'EXECUTE') AS ok");
    expect(r.rows[0].ok).toBe(false);
  });
});
