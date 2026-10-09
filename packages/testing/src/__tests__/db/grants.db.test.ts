// Gate 2 exit criterion: grant matrix (Phase 1 03 §12.1, errata G-5, B10). Non-worker roles can't write the ledger,
// the webhook role is insert-only, append-only tables have no UPDATE/DELETE grant, restricted roles have nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { asRole, createTestDatabase, knownSchemas, sqlState, type TestDatabase } from '../../db-harness.ts';

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const ROLES = ['app_api', 'app_admin', 'app_webhook', 'app_voice', 'app_worker', 'retention_executor', 'ops_readonly', 'analytics_etl'] as const;
type Matrix = Map<string, Map<string, Set<string>>>; // role -> table -> privileges

let db: TestDatabase;
let matrix: Matrix;
let tables: string[];

beforeAll(async () => {
  db = await createTestDatabase();
  const t = await db.admin.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition
      ORDER BY 1`,
    [[...knownSchemas()]],
  );
  tables = t.rows.map((r) => r.name as string);
  matrix = new Map();
  for (const role of ROLES) {
    const byTable = new Map<string, Set<string>>();
    for (const table of tables) {
      const granted = new Set<string>();
      for (const priv of PRIVS) {
        const r = await db.admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, table, priv]);
        if (r.rows[0].ok) granted.add(priv);
      }
      if (granted.size > 0) byTable.set(table, granted);
    }
    matrix.set(role, byTable);
  }
});
afterAll(async () => {
  await db?.close();
});

const privsOf = (role: string, table: string) => [...(matrix.get(role)?.get(table) ?? [])].sort();
const tablesWith = (role: string, priv: string) =>
  [...(matrix.get(role) ?? new Map<string, Set<string>>()).entries()].filter(([, p]) => p.has(priv)).map(([t]) => t).sort();

describe('grant matrix', () => {
  it('found the application tables', () => {
    expect(tables.length).toBeGreaterThan(90);
  });

  it('G-5 / B10: only app_worker can INSERT into ledger.*, nobody can UPDATE / DELETE / TRUNCATE it', () => {
    const ledger = tables.filter((t) => t.startsWith('ledger.')).sort();
    expect(ledger).toEqual(['ledger.accounts', 'ledger.balance_snapshots', 'ledger.entries', 'ledger.transactions']);
    for (const role of ROLES) {
      for (const t of ledger) {
        const p = privsOf(role, t);
        expect(p.includes('INSERT'), `${role} INSERT ${t}`).toBe(role === 'app_worker');
        expect(p.filter((x) => ['UPDATE', 'DELETE', 'TRUNCATE'].includes(x)), `${role} ${t}`).toEqual([]);
      }
    }
    for (const role of ['app_api', 'app_voice', 'app_webhook']) {
      expect(ledger.flatMap((t) => privsOf(role, t)), `${role} has no ledger access`).toEqual([]);
    }
  });

  it('webhook role is insert-only on the raw provider event store and has nothing else', () => {
    expect(Object.fromEntries([...(matrix.get('app_webhook') ?? [])].map(([t, p]) => [t, [...p].sort()]))).toEqual({
      'payments.provider_event_keys': ['INSERT'],
      'payments.provider_events': ['INSERT'],
    });
  });

  it('voice role matches the IVR command surface exactly (03 §12.1, X-11)', () => {
    expect(Object.fromEntries([...(matrix.get('app_voice') ?? [])].map(([t, p]) => [t, [...p].sort()]))).toEqual({
      'compliance.disclosure_events': ['INSERT'],
      'identity.ivr_credentials': ['SELECT', 'UPDATE'],
      'identity.users': ['SELECT'],
      'jobs.allowed_transitions': ['SELECT'],
      'jobs.assignment_status_history': ['INSERT'],
      'jobs.assignments': ['INSERT', 'SELECT', 'UPDATE'],
      'jobs.job_status_history': ['INSERT'],
      'jobs.jobs': ['SELECT', 'UPDATE'],
      'jobs.repair_order_status_history': ['INSERT'],
      'jobs.repair_orders': ['SELECT', 'UPDATE'],
      'jobs.visit_presence_proofs': ['INSERT'],
      'jobs.visit_status_history': ['INSERT'],
      'jobs.visit_waits': ['INSERT', 'SELECT', 'UPDATE'],
      'jobs.visits': ['SELECT', 'UPDATE'],
      'matching.offers': ['SELECT', 'UPDATE'],
      'payments.cash_collections': ['INSERT'],
      'platform.idempotency_keys': ['INSERT', 'SELECT', 'UPDATE'],
      'platform.outbox': ['INSERT'],
      'workforce.technician_daily_checkins': ['INSERT'],
      'workforce.technician_presence': ['INSERT', 'SELECT', 'UPDATE'],
      'workforce.technician_profiles': ['SELECT'],
    });
  });

  it('only the worker may DELETE, and nobody may TRUNCATE', () => {
    for (const role of ROLES) {
      if (role !== 'app_worker') expect(tablesWith(role, 'DELETE'), role).toEqual([]);
      expect(tablesWith(role, 'TRUNCATE'), role).toEqual([]);
    }
  });

  it('append-only tables have no UPDATE / DELETE grant for any role', async () => {
    const r = await db.admin.query(
      `SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgname = 'append_only_rows' AND NOT c.relispartition`,
    );
    const appendOnly = [...r.rows.map((x) => x.name as string), 'diagnosis.quote_items'];
    expect(appendOnly.length).toBeGreaterThanOrEqual(17);
    for (const role of ROLES) {
      for (const t of appendOnly) {
        expect(privsOf(role, t).filter((p) => p === 'UPDATE' || p === 'DELETE'), `${role} ${t}`).toEqual([]);
      }
    }
  });

  it('Gate 3: no runtime role inserts audit rows directly; all go through the hash-chain writer', async () => {
    for (const role of ROLES) expect(privsOf(role, 'compliance.audit_logs').filter((p) => p !== 'SELECT'), role).toEqual([]);
    for (const role of ['app_api', 'app_admin', 'app_voice', 'app_worker']) {
      const r = await db.admin.query(
        "SELECT has_function_privilege($1, 'platform.append_audit_log(uuid,text,uuid,uuid,text,text,uuid,uuid,text,text,jsonb,uuid,bytea,bytea)', 'EXECUTE') AS ok",
        [role]);
      expect(r.rows[0].ok, role).toBe(true);
    }
    for (const role of ['app_webhook', 'retention_executor', 'ops_readonly', 'analytics_etl']) {
      const r = await db.admin.query(
        "SELECT has_function_privilege($1, 'platform.append_audit_log(uuid,text,uuid,uuid,text,text,uuid,uuid,text,text,jsonb,uuid,bytea,bytea)', 'EXECUTE') AS ok",
        [role]);
      expect(r.rows[0].ok, role).toBe(false);
    }
  });

  it('Gate 3: the admin realm tables are reachable only by admin-api (and read by the worker)', () => {
    const adminTables = ['backoffice.admin_grants', 'backoffice.admin_sessions', 'backoffice.admin_users', 'backoffice.admin_webauthn_credentials',
      'backoffice.role_permissions', 'backoffice.roles', 'backoffice.webauthn_challenges'];
    for (const t of adminTables) {
      for (const role of ['app_api', 'app_voice', 'app_webhook']) expect(privsOf(role, t), `${role} ${t}`).toEqual([]);
      expect(privsOf('app_admin', t).includes('DELETE'), t).toBe(false);
    }
    expect(privsOf('app_admin', 'backoffice.roles')).toEqual(['SELECT']);
    expect(privsOf('app_admin', 'backoffice.role_permissions')).toEqual(['SELECT']);
  });

  it('restricted roles have no privileges until their views exist', () => {
    for (const role of ['retention_executor', 'ops_readonly', 'analytics_etl']) expect(matrix.get(role)?.size, role).toBe(0);
  });

  it('api has no access to backoffice, the ledger or raw provider events, and cannot read sensitive attributes', () => {
    for (const t of tables.filter((x) => x.startsWith('backoffice.') || x.startsWith('ledger.'))) expect(privsOf('app_api', t), t).toEqual([]);
    expect(privsOf('app_api', 'payments.provider_events')).toEqual([]);
    expect(privsOf('app_api', 'payments.provider_event_keys')).toEqual([]);
    expect(privsOf('app_api', 'customers.customer_sensitive_attributes')).toEqual(['INSERT']);
  });

  it('only the worker can read customer sensitive attributes', () => {
    for (const role of ROLES) {
      expect(privsOf(role, 'customers.customer_sensitive_attributes').includes('SELECT'), role).toBe(role === 'app_worker');
    }
  });

  it('PUBLIC has no table privileges in application schemas', async () => {
    const r = await db.admin.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name, a.privilege_type
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE n.nspname = ANY($1::text[]) AND a.grantee = 0`,
      [[...knownSchemas()]],
    );
    expect(r.rows).toEqual([]);
  });

  it('every runtime role can reach the tables it was granted (schema USAGE is in place)', async () => {
    for (const role of ['app_api', 'app_admin', 'app_webhook', 'app_voice', 'app_worker']) {
      for (const table of matrix.get(role)?.keys() ?? []) {
        const schema = table.split('.')[0] ?? '';
        const r = await db.admin.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [role, schema, 'USAGE']);
        expect(r.rows[0].ok, `${role} USAGE ${schema}`).toBe(true);
      }
    }
  });
});

describe('grant behaviour (as the role)', () => {
  it('app_api, app_admin, app_voice and app_webhook cannot insert a ledger transaction', async () => {
    for (const role of ['app_api', 'app_admin', 'app_voice', 'app_webhook']) {
      const state = await asRole(db.admin, role, () =>
        sqlState(db.admin, `INSERT INTO ledger.transactions (id, txn_type, idempotency_key, reference_type, reference_id, effective_at, created_by_actor_type)
                            VALUES ($1, 'X', $2, 'X', $3, now(), 'SYSTEM')`, [newId(), `k:${newId()}`, newId()]),
      );
      expect(state, role).toBe('42501');
    }
  });

  it('app_worker can write the ledger', async () => {
    const state = await asRole(db.admin, 'app_worker', () =>
      sqlState(db.admin, `INSERT INTO ledger.accounts (id, code, account_type, subtype, owner_type) VALUES ($1, 'SUSPENSE', 'LIABILITY', 'SUSPENSE', 'PLATFORM')`, [newId()]),
    );
    expect(state).toBe('OK');
  });

  it('app_webhook can insert a raw event but cannot read events back or touch anything else', async () => {
    await asRole(db.admin, 'app_webhook', async () => {
      expect(await sqlState(db.admin,
        `INSERT INTO payments.provider_events (id, provider, provider_event_id, event_type, signature_valid, payload_enc, processing_status)
         VALUES ($1, 'sandbox', $2, 'payment.captured', true, '\\x00', 'PENDING')`, [newId(), `evt_${newId()}`])).toBe('OK');
      expect(await sqlState(db.admin, 'SELECT count(*) FROM payments.provider_events')).toBe('42501');
      expect(await sqlState(db.admin, 'SELECT count(*) FROM jobs.jobs')).toBe('42501');
      expect(await sqlState(db.admin, 'SELECT count(*) FROM platform.outbox')).toBe('42501');
    });
  });

  it('app_api cannot read backoffice approvals or customer sensitive attributes', async () => {
    await asRole(db.admin, 'app_api', async () => {
      expect(await sqlState(db.admin, 'SELECT count(*) FROM backoffice.approval_requests')).toBe('42501');
      expect(await sqlState(db.admin, 'SELECT count(*) FROM customers.customer_sensitive_attributes')).toBe('42501');
    });
  });

  it('app_admin cannot delete anything', async () => {
    await asRole(db.admin, 'app_admin', async () => {
      expect(await sqlState(db.admin, 'DELETE FROM jobs.jobs WHERE false')).toBe('42501');
      expect(await sqlState(db.admin, 'DELETE FROM backoffice.approval_requests WHERE false')).toBe('42501');
    });
  });
});
