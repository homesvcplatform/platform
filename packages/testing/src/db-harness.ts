// Throwaway database harness for Gate 2 DB tests (TE-02: local / GitHub CI only, ephemeral PostgreSQL 17 + PostGIS).
// Needs HSP_TEST_DB_ADMIN_URL: the admin connection of a THROWAWAY container (CI service container). Each test file gets
// a fresh database: bootstrap as admin, then all migrations as the NON-superuser migrator role. Dropped afterwards.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  allSchemas, bootstrapCluster, bootstrapDatabase, loadMigrations, MIGRATOR_ROLE, ownershipFromModulesJson, runMigrations,
  type Migration,
} from '@hsp/db';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function repoMigrations(): Migration[] {
  const spec = JSON.parse(readFileSync(join(repoRoot, 'tools/architecture/modules.json'), 'utf8'));
  return loadMigrations(join(repoRoot, 'db/migrations'), allSchemas(ownershipFromModulesJson(spec)));
}

export function knownSchemas(): Set<string> {
  const spec = JSON.parse(readFileSync(join(repoRoot, 'tools/architecture/modules.json'), 'utf8'));
  return allSchemas(ownershipFromModulesJson(spec));
}

export interface TestDatabase {
  readonly name: string;
  /** Superuser connection to the test database (bootstrap and role-switching tests only). */
  readonly admin: pg.Client;
  /** Schema-owner connection (non-superuser), as migrations run in CI and on the managed database. */
  readonly migrator: pg.Client;
  readonly migratorUrl: string;
  readonly migrations: Migration[];
  close(): Promise<void>;
}

function adminUrl(): URL {
  const raw = process.env['HSP_TEST_DB_ADMIN_URL'];
  if (!raw) {
    throw new Error('HSP_TEST_DB_ADMIN_URL is not set. DB tests run in GitHub Actions (or locally against a throwaway PostGIS container).');
  }
  return new URL(raw);
}

export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const base = adminUrl();
  const name = `hsp_t_${randomBytes(6).toString('hex')}`;
  const migratorPassword = randomBytes(18).toString('base64url');

  const cluster = new pg.Client({ connectionString: base.toString() });
  await cluster.connect();
  await bootstrapCluster(cluster, { migratorPassword });
  await cluster.query(`CREATE DATABASE ${name}`);
  await cluster.end();

  const dbUrl = new URL(base.toString());
  dbUrl.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: dbUrl.toString() });
  await admin.connect();
  await bootstrapDatabase(admin, name);

  const migratorUrl = new URL(dbUrl.toString());
  migratorUrl.username = MIGRATOR_ROLE;
  migratorUrl.password = migratorPassword;
  const migrator = new pg.Client({ connectionString: migratorUrl.toString() });
  await migrator.connect();

  const migrations = repoMigrations();
  if (opts.migrate !== false) await runMigrations(migrator, migrations);

  return {
    name,
    admin,
    migrator,
    migratorUrl: migratorUrl.toString(),
    migrations,
    async close() {
      await migrator.end();
      await admin.end();
      const drop = new pg.Client({ connectionString: base.toString() });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await drop.end();
    },
  };
}

/** Runs `fn` as `role` (SET LOCAL ROLE) inside a transaction that is always rolled back. */
export async function asRole<T>(client: pg.Client, role: string, fn: () => Promise<T>): Promise<T> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`unsafe role ${role}`);
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Runs `fn` in a transaction that is always rolled back (each test starts from the same state). */
export async function inRollback<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Resolves to the SQLSTATE of the rejection (or 'OK'). Uses a savepoint so the surrounding transaction survives. */
export async function sqlState(client: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return 'OK';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

/** Like sqlState but also runs SET CONSTRAINTS ALL IMMEDIATE so deferred (commit-time) checks fire. */
export async function sqlStateAtCommit(client: pg.Client, statements: { sql: string; params?: unknown[] }[]): Promise<string> {
  await client.query('SAVEPOINT probe');
  try {
    for (const s of statements) await client.query(s.sql, s.params ?? []);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('RELEASE SAVEPOINT probe');
    return 'OK';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}
