// One-time administrative setup that migrations cannot do as the non-superuser migrator (TE-02 restriction 2):
// cluster roles and extensions. On a managed database this is run by the platform's administrator account (the RDS
// master user, never by application code). Locally and in CI it is run by the throwaway container's admin user.
// Everything here is idempotent.
import { ALL_DB_GROUP_ROLES, MIGRATOR_ROLE } from './roles.ts';
import type { Queryable } from './migrate.ts';

/** Extensions required by the schema (Phase 1 03 §1). pg_partman / pgaudit are deferred: see ADR-023. */
export const REQUIRED_EXTENSIONS = ['postgis', 'btree_gist', 'pg_trgm', 'pgcrypto'] as const;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Creates the group roles (NOLOGIN) and the migrator login role. Sets the migrator password when given. */
export async function bootstrapCluster(admin: Queryable, opts: { migratorPassword?: string } = {}): Promise<void> {
  for (const role of ALL_DB_GROUP_ROLES) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rows.length === 0) {
      await admin.query(`CREATE ROLE ${ident(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }
  }
  const migrator = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [MIGRATOR_ROLE]);
  if (migrator.rows.length === 0) {
    await admin.query(`CREATE ROLE ${ident(MIGRATOR_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  if (opts.migratorPassword !== undefined) {
    await admin.query(`ALTER ROLE ${ident(MIGRATOR_ROLE)} PASSWORD ${literal(opts.migratorPassword)}`);
  }
}

/** Per-database setup: extensions, and CONNECT/CREATE rights. Run while connected to the target database. */
export async function bootstrapDatabase(admin: Queryable, databaseName: string): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS) {
    await admin.query(`CREATE EXTENSION IF NOT EXISTS ${ident(extension)}`);
  }
  const db = ident(databaseName);
  await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${ident(MIGRATOR_ROLE)}`);
  for (const role of ALL_DB_GROUP_ROLES) {
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${ident(role)}`);
  }
  // PostgreSQL 15+ already denies CREATE on public to PUBLIC; state it explicitly so the intent survives upgrades.
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
}
