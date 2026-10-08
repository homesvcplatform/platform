import { describe, expect, it } from 'vitest';
import { checksumOf, MigrationError, parseMigrations, runMigrations, type Queryable } from '../migrate.ts';

const known = new Set(['platform', 'geo', 'jobs']);

describe('parseMigrations', () => {
  it('orders files and computes checksums', () => {
    const ms = parseMigrations(
      [
        { name: '0002_geo__core.sql', sql: 'SELECT 2;' },
        { name: '0001_platform__foundation.sql', sql: 'SELECT 1;' },
      ],
      known,
    );
    expect(ms.map((m) => m.fileName)).toEqual(['0001_platform__foundation.sql', '0002_geo__core.sql']);
    expect(ms[1]?.schema).toBe('geo');
    expect(ms[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats CRLF and LF content as the same checksum', () => {
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
  });

  it.each([
    [[{ name: '0001_geo__core.sql', sql: 'x' }, { name: '0003_geo__more.sql', sql: 'y' }], /expected version 0002/],
    [[{ name: '0001_geo__core.sql', sql: 'x' }, { name: '0001_geo__dup.sql', sql: 'y' }], /expected version 0002/],
    [[{ name: '0001_payments__core.sql', sql: 'x' }], /not a known owning schema/],
    [[{ name: '1_geo__core.sql', sql: 'x' }], /must match/],
    [[{ name: '0001_geo__core.sql', sql: '   ' }], /empty migration/],
  ])('rejects invalid sets %#', (files, message) => {
    expect(() => parseMigrations(files, known)).toThrow(message);
  });
});

/** In-memory stand-in for the parts of PostgreSQL the runner talks to. */
function fakeDb(opts: { superuser?: boolean; applied?: { version: number; file_name: string; checksum: string }[]; failOn?: string } = {}) {
  const executed: string[] = [];
  const applied = [...(opts.applied ?? [])];
  const db: Queryable = {
    async query(sql, params) {
      executed.push(sql);
      if (opts.failOn && sql === opts.failOn) throw new Error('boom');
      if (sql.startsWith('SELECT current_user')) return { rows: [{ name: 'migrator', super: opts.superuser ?? false }] };
      if (sql.startsWith('SELECT version, file_name, checksum')) return { rows: applied };
      if (sql.startsWith('INSERT INTO platform.schema_migrations')) {
        const [version, file_name, checksum] = params as [number, string, string];
        applied.push({ version, file_name, checksum });
      }
      return { rows: [] };
    },
  };
  return { db, executed, applied };
}

describe('runMigrations', () => {
  const ms = parseMigrations(
    [
      { name: '0001_platform__foundation.sql', sql: 'CREATE TABLE platform.a();' },
      { name: '0002_geo__core.sql', sql: 'CREATE TABLE geo.b();' },
    ],
    known,
  );

  it('applies pending migrations in order, each in its own transaction with timeouts', async () => {
    const { db, executed, applied } = fakeDb();
    const result = await runMigrations(db, ms);
    expect(result.applied).toEqual(['0001_platform__foundation.sql', '0002_geo__core.sql']);
    expect(applied.map((a) => a.version)).toEqual([1, 2]);
    const firstTx = executed.slice(executed.indexOf('BEGIN'), executed.indexOf('COMMIT') + 1);
    expect(firstTx).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '3s'",
      "SET LOCAL statement_timeout = '60s'",
      'SET LOCAL search_path = public',
      'CREATE TABLE platform.a();',
      expect.stringContaining('INSERT INTO platform.schema_migrations'),
      'COMMIT',
    ]);
    expect(executed.at(-1)).toContain('pg_advisory_unlock');
  });

  it('is a no-op when everything is applied', async () => {
    const { db } = fakeDb({ applied: ms.map((m) => ({ version: m.version, file_name: m.fileName, checksum: m.checksum })) });
    const result = await runMigrations(db, ms);
    expect(result).toEqual({ applied: [], alreadyApplied: 2 });
  });

  it('refuses a modified applied migration (forward-only)', async () => {
    const { db } = fakeDb({ applied: [{ version: 1, file_name: '0001_platform__foundation.sql', checksum: 'f'.repeat(64) }] });
    await expect(runMigrations(db, ms)).rejects.toThrow(/was modified/);
  });

  it('refuses when the database is ahead of the directory', async () => {
    const { db } = fakeDb({ applied: [{ version: 9, file_name: '0009_geo__x.sql', checksum: 'a'.repeat(64) }] });
    await expect(runMigrations(db, ms)).rejects.toThrow(/database is ahead/);
  });

  it('refuses to run as a superuser unless explicitly allowed', async () => {
    await expect(runMigrations(fakeDb({ superuser: true }).db, ms)).rejects.toThrow(MigrationError);
    await expect(runMigrations(fakeDb({ superuser: true }).db, ms, { allowSuperuser: true })).resolves.toBeDefined();
  });

  it('rolls back a failing migration, records nothing for it and releases the lock', async () => {
    const { db, executed, applied } = fakeDb({ failOn: 'CREATE TABLE geo.b();' });
    await expect(runMigrations(db, ms)).rejects.toThrow(/0002_geo__core.sql failed and was rolled back/);
    expect(applied.map((a) => a.version)).toEqual([1]);
    expect(executed).toContain('ROLLBACK');
    expect(executed.at(-1)).toContain('pg_advisory_unlock');
  });
});
