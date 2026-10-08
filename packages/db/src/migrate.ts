// Forward-only migration runner (Phase 1 03 §14.7). Rules:
// - Files are `NNNN_<schema>__<description>.sql` in one directory, numbered 0001.. without gaps or duplicates.
//   The prefix names the owning schema (module schema, an additional schema it owns, or `platform`).
// - Each file runs in its own transaction with lock/statement timeouts and records its SHA-256 checksum.
// - An applied migration is never edited: a checksum or name mismatch stops the run. A rollback is a NEW forward
//   migration ("reversible by forward fix").
// - Runs as the non-superuser `migrator` owner role (TE-02 restriction 2: managed-database fidelity).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Migration {
  readonly version: number;
  readonly schema: string;
  readonly description: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const FILE_PATTERN = /^(\d{4})_([a-z][a-z0-9_]*)__([a-z0-9][a-z0-9_]*)\.sql$/;
const LOCK_KEY = 'hsp:schema-migrations';

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/** Parses and validates migration files (pure: no database access). */
export function parseMigrations(files: readonly { name: string; sql: string }[], knownSchemas: ReadonlySet<string>): Migration[] {
  const errors: string[] = [];
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file.name);
    if (!match) {
      errors.push(`${file.name}: name must match NNNN_<schema>__<description>.sql`);
      continue;
    }
    const [, num, schema, description] = match as unknown as [string, string, string, string];
    if (!knownSchemas.has(schema)) errors.push(`${file.name}: "${schema}" is not a known owning schema`);
    if (file.sql.trim().length === 0) errors.push(`${file.name}: empty migration`);
    migrations.push({ version: Number(num), schema, description, fileName: file.name, sql: file.sql, checksum: checksumOf(file.sql) });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) errors.push(`${m.fileName}: expected version ${String(i + 1).padStart(4, '0')} (no gaps or duplicates)`);
  });
  if (errors.length > 0) throw new MigrationError(`Invalid migrations:\n - ${errors.join('\n - ')}`);
  return migrations;
}

export function loadMigrations(dir: string, knownSchemas: ReadonlySet<string>): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  return parseMigrations(files, knownSchemas);
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export interface RunOptions {
  /** Tests only: allow a superuser connection. Deployed and CI migration runs must use the migrator role. */
  readonly allowSuperuser?: boolean;
  readonly log?: (line: string) => void;
}

export async function runMigrations(db: Queryable, migrations: readonly Migration[], options: RunOptions = {}): Promise<MigrationRunResult> {
  const log = options.log ?? (() => {});
  const who = await db.query('SELECT current_user AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super');
  const identity = who.rows[0] as { name: string; super: boolean };
  if (identity.super && !options.allowSuperuser) {
    throw new MigrationError(`refusing to migrate as superuser "${identity.name}": run as the non-superuser migrator role`);
  }

  await db.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
  try {
    await db.query('CREATE SCHEMA IF NOT EXISTS platform');
    await db.query(`CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      version int PRIMARY KEY,
      file_name text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_by text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const appliedRows = (await db.query('SELECT version, file_name, checksum FROM platform.schema_migrations ORDER BY version')).rows as {
      version: number;
      file_name: string;
      checksum: string;
    }[];

    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    for (const row of appliedRows) {
      const file = byVersion.get(row.version);
      if (!file) throw new MigrationError(`database has migration ${row.file_name} that is not in the migrations directory (database is ahead)`);
      if (file.fileName !== row.file_name) throw new MigrationError(`migration ${row.version} was applied as ${row.file_name} but the file is now ${file.fileName}`);
      if (file.checksum !== row.checksum) {
        throw new MigrationError(`applied migration ${row.file_name} was modified (checksum mismatch). Write a new forward migration instead`);
      }
    }

    const appliedVersions = new Set(appliedRows.map((r) => r.version));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      log(`applying ${migration.fileName}`);
      await db.query('BEGIN');
      try {
        await db.query("SET LOCAL lock_timeout = '3s'");
        await db.query("SET LOCAL statement_timeout = '60s'");
        await db.query('SET LOCAL search_path = public');
        await db.query(migration.sql);
        await db.query('INSERT INTO platform.schema_migrations (version, file_name, checksum, applied_by) VALUES ($1, $2, $3, current_user)', [
          migration.version,
          migration.fileName,
          migration.checksum,
        ]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`${migration.fileName} failed and was rolled back: ${reason}`);
      }
      applied.push(migration.fileName);
    }
    return { applied, alreadyApplied: appliedRows.length };
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  }
}
