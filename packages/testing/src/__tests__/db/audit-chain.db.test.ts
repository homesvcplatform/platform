// Gate 3: hash-chained audit log (Phase 1 11 §8, 05 §10). Writes go only through platform.append_audit_log as the
// runtime roles; the chain verifies, survives concurrent writers, and any tampering (edited, deleted or forged rows,
// or a rewound head) is detected. change_summary can't carry personal data.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, AuditEntryError } from '@hsp/db';
import { newId } from '@hsp/kernel';
import { createTestDatabase, type TestDatabase } from '../../db-harness.ts';

let db: TestDatabase;
let api: pg.Pool;
let worker: pg.Pool;
let month: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = new pg.Pool({ connectionString: await db.loginFor('app_api'), max: 10 });
  worker = new pg.Pool({ connectionString: await db.loginFor('app_worker'), max: 2 });
});
afterAll(async () => {
  await api?.end();
  await worker?.end();
  await db?.close();
});

const entry = (action = 'auth.login_succeeded') => ({
  actorType: 'CUSTOMER' as const, actorId: newId(), action, resourceType: 'identity.session', resourceId: newId(), outcome: 'SUCCESS' as const,
  changeSummary: { surface: 'CUSTOMER_WEB', newDevice: true }, requestId: randomUUID(),
});
const verify = async () => (await db.admin.query('SELECT * FROM compliance.verify_audit_chain($1)', [month])).rows[0] as { ok: boolean; rows_checked: string; first_bad_id: string | null };

describe('audit hash chain', () => {
  it('appends through the writer (api role) and verifies; concurrent writers keep one linear chain', async () => {
    await appendAudit(api, entry());
    month = (await db.admin.query('SELECT chain_partition FROM compliance.audit_chain_heads')).rows[0].chain_partition as string;
    await Promise.all(Array.from({ length: 25 }, () => appendAudit(api, entry())));
    const v = await verify();
    expect(v).toMatchObject({ ok: true, first_bad_id: null });
    expect(Number(v.rows_checked)).toBe(26);
    const links = await db.admin.query('SELECT count(DISTINCT prev_hash)::int AS n, count(*)::int AS total FROM compliance.audit_logs');
    expect(links.rows[0].n).toBe(links.rows[0].total); // no forks
  });

  it('runtime roles can\'t insert audit rows directly (a forged row would bypass the chain)', async () => {
    const c = await api.connect();
    try {
      await expect(c.query(`INSERT INTO compliance.audit_logs (id, actor_type, action, resource_type, outcome, chain_partition, prev_hash, row_hash)
        VALUES ($1, 'SYSTEM', 'x.y', 'x', 'SUCCESS', $2, $3, $3)`, [newId(), month, Buffer.alloc(32)])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT count(*) FROM compliance.audit_chain_heads')).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release();
    }
    const w = await worker.connect();
    try {
      expect((await w.query('SELECT ok FROM compliance.verify_audit_chain($1)', [month])).rows[0].ok).toBe(true); // worker can verify
    } finally {
      w.release();
    }
  });

  it('change_summary refuses personal-data field names and free-text values', async () => {
    await expect(appendAudit(api, { ...entry(), changeSummary: { phone: 'x' } })).rejects.toBeInstanceOf(AuditEntryError);
    await expect(appendAudit(api, { ...entry(), changeSummary: { note: 'called +910000000201 at home' } })).rejects.toBeInstanceOf(AuditEntryError);
    await expect(appendAudit(api, { ...entry(), reasonCode: 'free text' })).rejects.toBeInstanceOf(AuditEntryError);
    await expect(appendAudit(api, { ...entry('Not An Action') })).rejects.toThrow();
  });

  it('detects an edited row, a deleted tail row and a forged row (tampering by a superuser)', async () => {
    const target = (await db.admin.query('SELECT id FROM compliance.audit_logs ORDER BY occurred_at LIMIT 1 OFFSET 5')).rows[0].id as string;
    await db.admin.query('BEGIN');
    try {
      await db.admin.query("SET LOCAL session_replication_role = 'replica'"); // bypasses the append-only triggers
      await db.admin.query("UPDATE compliance.audit_logs SET outcome = 'DENIED' WHERE id = $1", [target]);
      expect(await verify()).toMatchObject({ ok: false, first_bad_id: target });
    } finally {
      await db.admin.query('ROLLBACK');
    }
    expect((await verify()).ok).toBe(true);

    await db.admin.query('BEGIN');
    try {
      await db.admin.query("SET LOCAL session_replication_role = 'replica'");
      await db.admin.query('DELETE FROM compliance.audit_logs WHERE id = (SELECT id FROM compliance.audit_logs ORDER BY occurred_at DESC LIMIT 1)');
      expect(await verify()).toMatchObject({ ok: false, first_bad_id: null }); // head no longer matches
    } finally {
      await db.admin.query('ROLLBACK');
    }

    await db.admin.query('BEGIN');
    try {
      const last = (await db.admin.query('SELECT row_hash FROM compliance.audit_logs ORDER BY occurred_at DESC LIMIT 1')).rows[0].row_hash as Buffer;
      const forged = newId();
      await db.admin.query(`INSERT INTO compliance.audit_logs (id, occurred_at, actor_type, action, resource_type, outcome, chain_partition, prev_hash, row_hash)
        VALUES ($1, clock_timestamp(), 'SYSTEM', 'x.forged', 'x', 'SUCCESS', $2, $3, $3)`, [forged, month, last]);
      expect(await verify()).toMatchObject({ ok: false, first_bad_id: forged });
    } finally {
      await db.admin.query('ROLLBACK');
    }
    expect((await verify()).ok).toBe(true);
  });

  it('append-only still holds for the owner', async () => {
    await expect(db.migrator.query("UPDATE compliance.audit_logs SET outcome = 'FAILED'")).rejects.toMatchObject({ code: 'HS001' });
  });
});
