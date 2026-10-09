// Gate 3 review fix: migration 0029 handles incompatible pre-existing data explicitly. Active city-scoped grants of
// global-only roles stop the migration with an actionable error (grants are never deleted or rewritten); expired or
// consumed pre-migration WebAuthn challenges are deleted as disposable; a live pre-migration challenge stops it too.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@hsp/db';
import { newId } from '@hsp/kernel';
import { createTestDatabase, type TestDatabase } from '../../db-harness.ts';

let db: TestDatabase;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
  await runMigrations(db.migrator, db.migrations.filter((m) => m.version <= 28));
});
afterAll(async () => {
  await db?.close();
});

const q = (sql: string, params: unknown[] = []) => db.migrator.query(sql, params);
const count = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0].n as number;
const applied = async () => count('SELECT count(*)::int AS n FROM platform.schema_migrations');

async function admin(name: string) {
  ids[name] = newId();
  await q("INSERT INTO backoffice.admin_users (id, idp_subject, status) VALUES ($1, $2, 'ACTIVE')", [ids[name], name]);
}

async function grant(name: string, grantee: string, role: string, scope: 'GLOBAL' | 'CITIES', revoked: boolean) {
  const approval = newId();
  await q(`INSERT INTO backoffice.approval_requests (id, action_type, resource_type, resource_id, payload, payload_hash, risk_level, requested_by_admin_id,
             required_approver_permission, decided_by_admin_id, decided_at, status, expires_at)
           VALUES ($1, 'security.grant', 'backoffice.admin_user', $2, '{}', $3, 'HIGH', $4, 'security.grant.approve', $5, now(), 'EXECUTED', now() + interval '1 day')`,
  [approval, ids[grantee], randomBytes(32), ids['maker'], ids['checker']]);
  ids[name] = newId();
  await q(`INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, city_ids, granted_by_admin_id, approved_by_admin_id, approval_request_id, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [ids[name], ids[grantee], role, scope, scope === 'CITIES' ? ['0190f0aa-0000-7000-8000-00000000c1c1'] : [], ids['maker'], ids['checker'], approval,
    revoked ? new Date() : null]);
}

async function challenge(name: string, purpose: 'STEP_UP' | 'REGISTRATION', opts: { expired?: boolean; consumed?: boolean }) {
  ids[name] = newId();
  await q(`INSERT INTO backoffice.webauthn_challenges (id, admin_user_id, session_id, purpose, challenge_hash, action, expires_at, consumed_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval, $8)`,
  [ids[name], ids['maker'], ids['session'], purpose, randomBytes(32), purpose === 'STEP_UP' ? 'security.grant.approve' : null,
    opts.expired ? '-1 minute' : '5 minutes', opts.consumed ? new Date() : null]);
}

describe('migration 0029: pre-existing data', () => {
  it('stops on an active city-scoped grant of a global-only role, naming it, and changes nothing', async () => {
    for (const n of ['maker', 'checker', 'grantee', 'other']) await admin(n);
    ids['session'] = newId();
    await q(`INSERT INTO backoffice.admin_sessions (id, admin_user_id, token_hash, auth_methods, idle_expires_at, absolute_expires_at)
             VALUES ($1, $2, $3, '{idp,hwk}', now() + interval '30 minutes', now() + interval '10 hours')`, [ids['session'], ids['maker'], randomBytes(32)]);
    await grant('activeCitySec', 'grantee', 'SECURITY_ADMIN', 'CITIES', false);
    await grant('revokedCityFinance', 'other', 'FINANCE', 'CITIES', true);
    await grant('cityDispatch', 'other', 'DISPATCH', 'CITIES', false);
    await challenge('expiredStepUp', 'STEP_UP', { expired: true });
    await challenge('consumedRegistration', 'REGISTRATION', { consumed: true });
    await challenge('liveStepUp', 'STEP_UP', {});

    const before = await applied();
    await expect(runMigrations(db.migrator, db.migrations)).rejects.toThrow(new RegExp(`global-only roles exist: ${ids['activeCitySec']} \\(SECURITY_ADMIN\\)`));
    expect(await applied()).toBe(before);
    expect(await count('SELECT count(*)::int AS n FROM backoffice.webauthn_challenges')).toBe(3); // rolled back: nothing deleted
    expect(await count('SELECT count(*)::int AS n FROM backoffice.admin_grants')).toBe(3);
  });

  it('after the grant is revoked, stops on a live pre-migration challenge (re-run after it expires)', async () => {
    await q('UPDATE backoffice.admin_grants SET revoked_at = now() WHERE id = $1', [ids['activeCitySec']]);
    await expect(runMigrations(db.migrator, db.migrations)).rejects.toThrow(/1 unexpired, unconsumed WebAuthn challenge/);
    expect(await count('SELECT count(*)::int AS n FROM backoffice.webauthn_challenges')).toBe(3);
  });

  it('once the challenge has expired, deletes only disposable challenges, keeps every grant, and applies', async () => {
    await q("UPDATE backoffice.webauthn_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [ids['liveStepUp']]);
    const result = await runMigrations(db.migrator, db.migrations);
    expect(result.applied.some((f) => f.startsWith('0029_'))).toBe(true);
    expect(await count('SELECT count(*)::int AS n FROM backoffice.webauthn_challenges')).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM backoffice.admin_grants WHERE id = ANY($1::uuid[])',
      [[ids['activeCitySec'], ids['revokedCityFinance'], ids['cityDispatch']]])).toBe(3);
    expect(await count("SELECT count(*)::int AS n FROM backoffice.roles WHERE global_only AND code IN ('SECURITY_ADMIN','FINANCE','AUDITOR')")).toBe(3);
    // The revoked city-scoped grants remain history; any attempt to reactivate them as city grants is refused.
    await expect(q('UPDATE backoffice.admin_grants SET scope_kind = scope_kind WHERE id = $1', [ids['revokedCityFinance']])).rejects.toMatchObject({ code: 'HS020' });
  });
});
