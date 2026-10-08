// Gate 2 exit criterion: migrations apply as the non-superuser owner, are forward-only, and a change is reversed by a
// forward fix ("reversible-by-forward-fix rehearsed").
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMigrations, runMigrations } from '@hsp/db';
import { createTestDatabase, knownSchemas, type TestDatabase } from '../../db-harness.ts';
import { must } from '../../fixtures/kurnool.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function schemaFingerprint(): Promise<string> {
  const r = await db.admin.query(
    `SELECT md5(string_agg(table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ','
                ORDER BY table_schema, table_name, ordinal_position)) AS fp
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public', 'tiger', 'topology')`,
  );
  return r.rows[0].fp as string;
}

describe('migrations', () => {
  it('applied every migration as the non-superuser migrator', async () => {
    const role = await db.admin.query("SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = 'migrator'");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    const applied = await db.admin.query('SELECT version, applied_by FROM platform.schema_migrations ORDER BY version');
    expect(applied.rows.map((r) => r.version)).toEqual(db.migrations.map((m) => m.version));
    expect(new Set(applied.rows.map((r) => r.applied_by))).toEqual(new Set(['migrator']));
  });

  it('created every module schema, owned by the migrator', async () => {
    const r = await db.admin.query(
      `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ANY($1::text[])`,
      [[...knownSchemas()]],
    );
    expect(r.rows.map((x) => x.nspname).sort()).toEqual([...knownSchemas()].sort());
    for (const row of r.rows) expect(row.owner).toBe('migrator');
  });

  it('re-running is a no-op', async () => {
    const result = await runMigrations(db.migrator, db.migrations);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe(db.migrations.length);
  });

  it('refuses an applied migration whose content changed', async () => {
    const original = must(db.migrations[0], 'first migration');
    const tampered = [{ ...original, checksum: 'f'.repeat(64) }, ...db.migrations.slice(1)];
    await expect(runMigrations(db.migrator, tampered)).rejects.toThrow(/was modified/);
  });

  it('rolls back a failing migration completely', async () => {
    const next = db.migrations.length + 1;
    const broken = parseMigrations(
      [
        ...db.migrations.map((m) => ({ name: m.fileName, sql: m.sql })),
        { name: `${String(next).padStart(4, '0')}_platform__broken.sql`, sql: 'CREATE TABLE platform.should_not_exist (id int); SELECT 1/0;' },
      ],
      knownSchemas(),
    );
    await expect(runMigrations(db.migrator, broken)).rejects.toThrow(/failed and was rolled back/);
    const t = await db.admin.query("SELECT to_regclass('platform.should_not_exist') AS t");
    expect(t.rows[0].t).toBeNull();
    const n = await db.admin.query('SELECT count(*)::int AS n FROM platform.schema_migrations');
    expect(n.rows[0].n).toBe(db.migrations.length);
  });

  it('rehearses a reversal by forward fix: expand, then a new migration restores the schema', async () => {
    const before = await schemaFingerprint();
    const n = db.migrations.length;
    const files = [
      ...db.migrations.map((m) => ({ name: m.fileName, sql: m.sql })),
      {
        name: `${String(n + 1).padStart(4, '0')}_geo__rehearsal_expand.sql`,
        sql: "ALTER TABLE geo.cities ADD COLUMN rehearsal_note text;\nSELECT platform.classify('geo.cities', 'I');",
      },
      { name: `${String(n + 2).padStart(4, '0')}_geo__rehearsal_forward_fix.sql`, sql: 'ALTER TABLE geo.cities DROP COLUMN rehearsal_note;' },
    ];
    const withExpand = parseMigrations(files.slice(0, n + 1), knownSchemas());
    await runMigrations(db.migrator, withExpand);
    expect(await schemaFingerprint()).not.toBe(before);
    const withFix = parseMigrations(files, knownSchemas());
    const result = await runMigrations(db.migrator, withFix);
    expect(result.applied).toEqual([must(files[n + 1], 'forward fix').name]);
    expect(await schemaFingerprint()).toBe(before);
  });

  it('creates runtime roles without login or elevated attributes', async () => {
    const r = await db.admin.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles
        WHERE rolname IN ('app_api','app_admin','app_webhook','app_voice','app_worker','retention_executor','ops_readonly','analytics_etl')
        ORDER BY rolname`,
    );
    expect(r.rows).toHaveLength(8);
    for (const role of r.rows) {
      expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    }
  });

  it('installs the required extensions', async () => {
    const r = await db.admin.query('SELECT extname FROM pg_extension');
    const names = r.rows.map((x) => x.extname);
    for (const ext of ['postgis', 'btree_gist', 'pg_trgm', 'pgcrypto']) expect(names).toContain(ext);
  });
});
