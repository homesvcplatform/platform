// Connection pools per process role (ADR-019). Each deployed process connects with its own login user, which is a
// member of exactly one runtime group role (app_api, app_worker, ...). The pool never runs as the migrator/owner or a
// superuser: `assertRuntimeIdentity` is called at boot and refuses to start otherwise.
import pg from 'pg';
import { MIGRATOR_ROLE, type RuntimeDbRole } from './roles.ts';
import type { Queryable } from './migrate.ts';

export interface RolePoolOptions {
  readonly connectionString: string;
  readonly dbRole: RuntimeDbRole;
  readonly max?: number;
}

export function createRolePool(opts: RolePoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: `hsp:${opts.dbRole}`,
    // App schemas are always schema-qualified; `public` only holds extensions (PostGIS types and functions).
    options: '-c search_path=public -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
  });
}

export class DatabaseIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseIdentityError';
  }
}

export async function assertRuntimeIdentity(db: Queryable, expected: RuntimeDbRole): Promise<void> {
  const result = await db.query(
    `SELECT current_user AS name,
            r.rolsuper AS super,
            pg_has_role(current_user, $1, 'MEMBER') AS member,
            pg_has_role(current_user, $2, 'MEMBER') AS is_owner
       FROM pg_roles r WHERE r.rolname = current_user`,
    [expected, MIGRATOR_ROLE],
  );
  const row = result.rows[0] as { name: string; super: boolean; member: boolean; is_owner: boolean } | undefined;
  if (!row) throw new DatabaseIdentityError('could not determine the database identity');
  if (row.super) throw new DatabaseIdentityError(`runtime connection "${row.name}" is a superuser`);
  if (row.is_owner) throw new DatabaseIdentityError(`runtime connection "${row.name}" has the schema owner role`);
  if (!row.member) throw new DatabaseIdentityError(`runtime connection "${row.name}" is not a member of ${expected}`);
}

/** Runs `fn` inside BEGIN/COMMIT on one pooled client; rolls back on any error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
