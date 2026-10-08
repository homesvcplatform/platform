// Gate 2 exit criterion: no PII column without a classification tag (03 §1), plus the G-7 / SR-07 key-subject registry
// and pseudonymised-archive policy, and INV-27 (no plaintext Aadhaar / card / UPI PIN / OTP / IVR PIN columns).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, knownSchemas, type TestDatabase } from '../../db-harness.ts';

interface Column {
  table: string;
  column: string;
  type: string;
  tag: string | null;
}

let db: TestDatabase;
let columns: Column[];

beforeAll(async () => {
  db = await createTestDatabase();
  const r = await db.admin.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type,
            col_description(c.oid, a.attnum) AS tag
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, a.attnum`,
    [[...knownSchemas()]],
  );
  columns = r.rows as Column[];
});
afterAll(async () => {
  await db?.close();
});

const TAG = /^[PICR](,(enc|bidx))?$/;

describe('classification tags', () => {
  it('every column in every application table carries a valid tag', () => {
    expect(columns.length).toBeGreaterThan(900);
    const missing = columns.filter((c) => c.tag === null || !TAG.test(c.tag)).map((c) => `${c.table}.${c.column}=${c.tag}`);
    expect(missing).toEqual([]);
  });

  it('encrypted columns are bytea, named *_enc, and tagged C,enc or R,enc (and vice versa)', () => {
    for (const c of columns) {
      const isEnc = c.column.endsWith('_enc');
      expect(isEnc, `${c.table}.${c.column}`).toBe(c.tag === 'C,enc' || c.tag === 'R,enc');
      if (isEnc) expect(c.type, `${c.table}.${c.column}`).toBe('bytea');
    }
  });

  it('blind-index columns are named *_bidx and tagged C,bidx or R,bidx (and vice versa)', () => {
    for (const c of columns) {
      expect(c.column.endsWith('_bidx'), `${c.table}.${c.column}`).toBe(c.tag === 'C,bidx' || c.tag === 'R,bidx');
    }
  });

  it('secret-derived columns (hashes / HMACs / wrapped keys) are Restricted', () => {
    const secretDerived = columns.filter((c) => /^(token_hash|code_hmac|pin_hash|start_code_hash|completion_code_hash|wrapped_dek)$/.test(c.column));
    expect(secretDerived.length).toBeGreaterThanOrEqual(7);
    for (const c of secretDerived) expect(c.tag, `${c.table}.${c.column}`).toBe('R');
  });

  it('INV-27: no column could hold a plaintext Aadhaar, card number, UPI PIN, OTP or IVR PIN', () => {
    const forbidden = columns.filter((c) => /(aadhaar|aadhar|card_number|pan_number|upi_pin|otp_code|^otp$|^pin$|ivr_pin)/i.test(c.column));
    expect(forbidden.map((c) => `${c.table}.${c.column}`)).toEqual([]);
  });

  it('known personal / restricted data is not tagged Public or Internal', () => {
    const expectTag = (table: string, column: string, tags: string[]) => {
      const col = columns.find((c) => c.table === table && c.column === column);
      expect(col, `${table}.${column}`).toBeDefined();
      expect(tags, `${table}.${column}`).toContain(col?.tag);
    };
    expectTag('workforce.technician_profiles', 'birth_year', ['C']);
    expectTag('workforce.payout_methods', 'ifsc', ['R']);
    expectTag('workforce.payout_methods', 'name_match_score', ['R']);
    expectTag('customers.customer_sensitive_attributes', 'gender_enc', ['R,enc']);
    expectTag('workforce.technician_profiles', 'worker_attributes_enc', ['R,enc']);
    expectTag('identity.otp_challenges', 'ip_hash', ['C']);
    expectTag('compliance.audit_logs', 'change_summary', ['C']);
  });
});

describe('key-subject registry (G-7 / SR-07)', () => {
  it('registers every encrypted column, and only existing ones', async () => {
    const encrypted = columns.filter((c) => c.column.endsWith('_enc')).map((c) => `${c.table}.${c.column}`).sort();
    const r = await db.admin.query(
      `SELECT format('%I.%I', table_schema, table_name) || '.' || column_name AS col, key_subject, subject_column
         FROM platform.encrypted_columns ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.col as string).sort()).toEqual(encrypted);
  });

  it("each subject column exists on the same table and is a uuid; platform-key columns state their minimisation", async () => {
    const r = await db.admin.query('SELECT table_schema, table_name, column_name, key_subject, subject_column, minimisation FROM platform.encrypted_columns');
    for (const row of r.rows) {
      if (row.key_subject === 'PLATFORM') {
        expect(row.minimisation, `${row.table_name}.${row.column_name}`).toBeTruthy();
        continue;
      }
      const subject = columns.find((c) => c.table === `${row.table_schema}.${row.table_name}` && c.column === row.subject_column);
      expect(subject?.type, `${row.table_name}.${row.subject_column}`).toBe('uuid');
    }
  });
});

describe('archive policy (03 §14.8, G-7)', () => {
  it('every partitioned table has an archive / retention policy', async () => {
    const parents = await db.admin.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'p' AND n.nspname = ANY($1::text[]) ORDER BY 1`,
      [[...knownSchemas()]],
    );
    const policies = await db.admin.query(`SELECT format('%I.%I', table_schema, table_name) AS name FROM platform.archive_policies ORDER BY 1`);
    expect(policies.rows.map((x) => x.name as string).sort()).toEqual(parents.rows.map((x) => x.name as string).sort());
  });

  it('archives never contain confidential, restricted, encrypted or blind-index columns', async () => {
    const r = await db.admin.query('SELECT table_schema, table_name, column_name, classification FROM platform.archive_columns');
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(['P', 'I'], `${row.table_name}.${row.column_name}`).toContain(row.classification);
      expect(row.column_name).not.toMatch(/_(enc|bidx)$/);
    }
    const audit = r.rows.filter((x) => x.table_name === 'audit_logs').map((x) => x.column_name);
    expect(audit).not.toContain('change_summary');
    expect(audit).not.toContain('ip_hash');
    expect(audit).toContain('row_hash');
  });
});
