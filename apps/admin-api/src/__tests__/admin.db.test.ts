// Gate 3 exit criteria for the admin realm: SSO through a test IdP with phishing-resistant MFA enforced, admin sessions
// (proxy assertion + session on every request, one concurrent session, CSRF), passkey registration and WebAuthn
// step-up (SR-03), maker-checker role grants (05 §5.4 / §6, INV-19), and the authorization matrix generator over
// every implemented capability (default deny elsewhere). Throwaway database, synthetic admins, no real IdP.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralKeyring, createLocalTokenSigningKey } from '@hsp/adapter-kms-local';
import { ManualClock, newId } from '@hsp/kernel';
import { createLogger } from '@hsp/observability';
import { hasPermission, MATRIX_COLUMNS, type Actor, type MatrixColumn } from '@hsp/policy';
import {
  createSoftAuthenticator, createTestDatabase, createTestIdp, generateMatrixCases, placeholderAction, type SoftAuthenticator, type TestDatabase,
} from '@hsp/testing';
import { composeAdminApi } from '../bootstrap.ts';

const ORIGIN = 'https://admin.test.invalid';
const RP_ID = 'admin.test.invalid';

let db: TestDatabase;
let pool: pg.Pool;
let app: ReturnType<typeof composeAdminApi>;
const clock = new ManualClock(new Date());
const idp = createTestIdp();
const logs: string[] = [];
const admins: Record<string, string> = {}; // name -> admin id (idp subject = name)
let checkerKey: SoftAuthenticator | undefined;

const meta = () => ({ requestId: randomUUID(), clientIp: '10.20.0.7' });

async function seedAdmin(name: string, status = 'ACTIVE'): Promise<string> {
  const id = newId();
  await db.migrator.query('INSERT INTO backoffice.admin_users (id, idp_subject, status) VALUES ($1, $2, $3)', [id, name, status]);
  admins[name] = id;
  return id;
}

/** Fixture grant (stands in for the break-glass bootstrap of the first security admins). */
async function seedGrant(grantee: string, role: string, maker: string, checker: string, scope: { kind: 'GLOBAL' } | { kind: 'CITIES'; cityIds: string[] } = { kind: 'GLOBAL' }) {
  const approval = newId();
  await db.migrator.query(
    `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, resource_id, payload, payload_hash, risk_level, requested_by_admin_id,
       required_approver_permission, decided_by_admin_id, decided_at, status, expires_at)
     VALUES ($1, 'security.grant', 'backoffice.admin_user', $2, '{}', $3, 'HIGH', $4, 'security.grant.approve', $5, now(), 'EXECUTED', now() + interval '1 day')`,
    [approval, admins[grantee], randomBytes(32), admins[maker], admins[checker]]);
  await db.migrator.query(
    `INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, city_ids, granted_by_admin_id, approved_by_admin_id, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), admins[grantee], role, scope.kind, scope.kind === 'CITIES' ? scope.cityIds : [], admins[maker], admins[checker], approval]);
}

interface AdminSession { cookie: string; csrf: string; assertion: string; name: string }

async function login(name: string, amr = ['hwk', 'user']): Promise<AdminSession> {
  const assertion = await idp.mint(name, { amr, now: clock.now() });
  const r = await app.http({ method: 'POST', path: '/admin/v1/session', headers: { 'x-proxy-assertion': assertion }, meta: meta() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: (r.headers['set-cookie'] ?? '').split(';')[0] ?? '', csrf: (r.body as { csrfToken: string }).csrfToken, assertion, name };
}

const req = (s: AdminSession, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => app.http({
  method, path, body, meta: meta(),
  headers: { 'x-proxy-assertion': s.assertion, cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, ...extra },
});

async function stepUp(s: AdminSession, authenticator: SoftAuthenticator, action = 'security.grant.approve') {
  const opt = await req(s, 'POST', '/admin/v1/step-up/options', { action });
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
  const a = authenticator.assert(challenge);
  return req(s, 'POST', '/admin/v1/step-up', { challengeId, credentialId: a.credentialId, clientDataJSON: a.clientDataJSON.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'), signature: a.signature.toString('base64url') });
}

async function registerPasskey(s: AdminSession): Promise<SoftAuthenticator> {
  const authenticator = createSoftAuthenticator(RP_ID, ORIGIN);
  const opt = await req(s, 'POST', '/admin/v1/passkeys/registration-options', {});
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
  const reg = authenticator.register(challenge);
  const done = await req(s, 'POST', '/admin/v1/passkeys', { challengeId, clientDataJSON: reg.clientDataJSON.toString('base64url'),
    attestationObject: reg.attestationObject.toString('base64url') });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  return authenticator;
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: await db.loginFor('app_admin'), max: 5 });
  const env = { APP_ENV: 'test' }; // Vitest adds DEV / PROD / MODE to process.env; the adapters' guards check the app env
  const signing = createLocalTokenSigningKey('k-admin-test', env);
  app = composeAdminApi({
    pool, clock, logger: createLogger('hsp-admin-test', 'debug', (l) => logs.push(l), () => clock.now()), idp: idp.config,
    webauthn: { rpId: RP_ID, origin: ORIGIN }, csrfKey: randomBytes(32), requestHashKey: randomBytes(32), allowedOrigins: [ORIGIN],
    identity: { kms: createEphemeralKeyring(env).forRole('admin-api'), keys: { otpPepper: randomBytes(32), blindIndexPepper: randomBytes(32),
      refreshRotationKey: randomBytes(32), csrfKey: randomBytes(32), requestHashKey: randomBytes(32) }, tokenSigner: signing.signer,
      tokenVerificationKeys: signing.publicKeys, issuer: 'https://auth.test.invalid' },
  });
  for (const n of ['sec-a', 'sec-b', 'sec-c', 'auditor-x', 'nobody']) await seedAdmin(n);
  await seedAdmin('suspended-admin', 'SUSPENDED');
  await seedGrant('sec-a', 'SECURITY_ADMIN', 'sec-b', 'sec-c');
  await seedGrant('sec-b', 'SECURITY_ADMIN', 'sec-a', 'sec-c');
  await seedGrant('sec-c', 'SUPPORT_L1', 'sec-a', 'sec-b', { kind: 'CITIES', cityIds: ['0190f0aa-0000-7000-8000-00000000c1c1'] });
});
afterAll(async () => {
  await pool?.end();
  await db?.close();
});

describe('admin SSO and sessions (05 §2.5)', () => {
  it('accepts a phishing-resistant IdP assertion; refuses SMS/TOTP/password, unknown, suspended and foreign-audience logins', async () => {
    const s = await login('sec-a');
    expect(s.cookie).toMatch(/^__Host-admin-sid=/);
    const tryLogin = async (assertion: string) =>
      (await app.http({ method: 'POST', path: '/admin/v1/session', headers: { 'x-proxy-assertion': assertion }, meta: meta() })).status;
    expect(await tryLogin(await idp.mint('sec-a', { amr: ['sms'], now: clock.now() }))).toBe(401);
    expect(await tryLogin(await idp.mint('sec-a', { amr: ['pwd', 'otp'], now: clock.now() }))).toBe(401);
    expect(await tryLogin(await idp.mint('unknown-admin', { now: clock.now() }))).toBe(401);
    expect(await tryLogin(await idp.mint('suspended-admin', { now: clock.now() }))).toBe(401);
    expect(await tryLogin(await idp.mint('sec-a', { audience: 'api', now: clock.now() }))).toBe(401);
    expect(await tryLogin(await createTestIdp({ issuer: idp.config.issuer }).mint('sec-a', { now: clock.now() }))).toBe(401); // foreign key
    expect(await tryLogin(await idp.mint('sec-a', { ttlSec: 3600, now: clock.now() }))).toBe(401); // over-long assertion
  });

  it('every request needs both the proxy assertion and the admin session; one concurrent session; CSRF on mutations', async () => {
    const first = await login('sec-b');
    const second = await login('sec-b');
    const body = { action: 'security.grant.approve' };
    expect((await req(first, 'POST', '/admin/v1/step-up/options', body)).status).toBe(401); // ended by the new login
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body, { 'x-proxy-assertion': '' })).status).toBe(401);
    const other = await idp.mint('sec-a', { now: clock.now() });
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body, { 'x-proxy-assertion': other })).status).toBe(401);
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body, { origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body)).status).toBe(200);
    clock.advance(31 * 60_000); // idle timeout
    expect((await req(second, 'POST', '/admin/v1/step-up/options', body, { 'x-proxy-assertion': await idp.mint('sec-b', { now: clock.now() }) })).status).toBe(401);
  });
});

describe('passkeys (SR-03)', () => {
  it('registers the first passkey right after login, then requires a passkey step-up for more; step-up assertions are verified', async () => {
    const s = await login('sec-c');
    const key = await registerPasskey(s);
    // A second passkey needs a recent step-up.
    expect((await req(s, 'POST', '/admin/v1/passkeys/registration-options', {})).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await stepUp(s, key)).status).toBe(204);
    expect((await req(s, 'POST', '/admin/v1/passkeys/registration-options', {})).status).toBe(200);
    // A different authenticator, a replayed challenge or a wrong origin are refused.
    expect((await stepUp(s, createSoftAuthenticator(RP_ID, ORIGIN))).status).toBe(401);
    const opt = await req(s, 'POST', '/admin/v1/step-up/options', { action: 'security.grant.approve' });
    const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
    const bad = key.assert(challenge, { origin: 'https://evil.invalid' });
    const send = (a: ReturnType<SoftAuthenticator['assert']>) => req(s, 'POST', '/admin/v1/step-up', { challengeId, credentialId: a.credentialId,
      clientDataJSON: a.clientDataJSON.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'), signature: a.signature.toString('base64url') });
    expect((await send(bad)).status).toBe(401);
    expect((await send(key.assert(challenge))).status).toBe(401); // challenge consumed by the failed attempt
  });

  it('the first passkey can only be enrolled within 10 minutes of a fresh IdP login', async () => {
    const s = await login('auditor-x');
    clock.advance(11 * 60_000);
    const fresh = { ...s, assertion: await idp.mint('auditor-x', { now: clock.now() }) };
    expect((await req(fresh, 'POST', '/admin/v1/passkeys/registration-options', {})).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});

describe('role grants: maker-checker (05 §5.4 / §6, INV-19)', () => {
  it('maker requests, a different checker with a fresh passkey step-up approves, the grant executes once', async () => {
    const maker = await login('sec-a');
    const checker = await login('sec-b');
    checkerKey = await registerPasskey(checker);
    const grant = { adminUserId: admins['auditor-x'], roleCode: 'AUDITOR', scope: { kind: 'GLOBAL' } };
    // No self-grant.
    expect((await req(maker, 'POST', '/admin/v1/grants', { ...grant, adminUserId: admins['sec-a'] }, { 'idempotency-key': randomUUID() })).body).toMatchObject({ code: 'FORBIDDEN' });
    const requested = await req(maker, 'POST', '/admin/v1/grants', grant, { 'idempotency-key': randomUUID() });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const id = (requested.body as { approvalRequestId: string }).approvalRequestId;
    const decide = (s: AdminSession, decision = 'APPROVE') => req(s, 'POST', `/admin/v1/approvals/${id}/decision`, { decision });
    expect((await decide(maker)).body).toMatchObject({ code: 'FORBIDDEN' }); // maker can't check
    expect((await decide(checker)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await stepUp(checker, checkerKey)).status).toBe(204);
    expect((await decide(checker)).status).toBe(204);
    expect((await decide(checker)).body).toMatchObject({ code: 'INVALID_STATE' }); // executed exactly once
    const row = (await db.admin.query('SELECT status FROM backoffice.approval_requests WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('EXECUTED');
    const auditor = await login('auditor-x');
    const actor = await app.backoffice.authenticate({ method: 'GET', proxyAssertion: auditor.assertion, cookieHeader: auditor.cookie, origin: undefined, csrfHeader: undefined });
    expect(hasPermission(actor, 'audit.read')).toBe(true);
    expect(hasPermission(actor, 'pii.reveal.phone')).toBe(false);
    expect(logs.some((l) => l.includes('security.admin_grant_changed'))).toBe(true);
  });

  it('a tampered approval payload is not executed', async () => {
    const maker = await login('sec-a');
    const r = await req(maker, 'POST', '/admin/v1/grants', { adminUserId: admins['nobody'], roleCode: 'FINANCE', scope: { kind: 'GLOBAL' } }, { 'idempotency-key': randomUUID() });
    const id = (r.body as { approvalRequestId: string }).approvalRequestId;
    await db.migrator.query(`UPDATE backoffice.approval_requests SET payload = jsonb_set(payload, '{roleCode}', '"SECURITY_ADMIN"') WHERE id = $1`, [id]);
    const checker = await login('sec-b');
    if (!checkerKey) throw new Error('the previous test registers the checker passkey');
    expect((await stepUp(checker, checkerKey)).status).toBe(204);
    const out = await req(checker, 'POST', `/admin/v1/approvals/${id}/decision`, { decision: 'APPROVE' });
    expect(out.body).toMatchObject({ code: 'INVALID_STATE' });
    const grants = (await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_grants WHERE admin_user_id = $1', [admins['nobody']])).rows[0];
    expect(grants.n).toBe(0);
  });

  it('the database itself refuses a grant approved by its maker or held by the approver (INV-19)', async () => {
    const approval = newId();
    await db.migrator.query(
      `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, payload, payload_hash, risk_level, requested_by_admin_id,
         required_approver_permission, status, expires_at)
       VALUES ($1, 'security.grant', 'backoffice.admin_user', '{}', $2, 'HIGH', $3, 'security.grant.approve', 'PENDING', now() + interval '1 day')`,
      [approval, randomBytes(32), admins['sec-a']]);
    await expect(db.migrator.query("UPDATE backoffice.approval_requests SET status = 'APPROVED', decided_by_admin_id = $2, decided_at = now() WHERE id = $1",
      [approval, admins['sec-a']])).rejects.toMatchObject({ code: '23514' });
    await expect(db.migrator.query(
      `INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, granted_by_admin_id, approved_by_admin_id, approval_request_id)
       VALUES ($1, $2, 'AUDITOR', 'GLOBAL', $3, $2, $4)`, [newId(), admins['nobody'], admins['sec-a'], approval])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('Idempotency-Key on POST /admin/v1/grants (04 §1.3)', () => {
  const approvals = async (grantee: string) =>
    ((await db.admin.query("SELECT count(*)::int AS n FROM backoffice.approval_requests WHERE resource_id = $1 AND status = 'PENDING'", [grantee])).rows[0].n as number);

  it('requires a UUID key', async () => {
    const maker = await login('sec-a');
    const body = { adminUserId: admins['nobody'], roleCode: 'AUDITOR', scope: { kind: 'GLOBAL' } };
    expect((await req(maker, 'POST', '/admin/v1/grants', body)).body).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'Idempotency-Key', code: 'REQUIRED' }] });
    expect((await req(maker, 'POST', '/admin/v1/grants', body, { 'idempotency-key': 'not-a-uuid' })).body).toMatchObject({ fields: [{ code: 'INVALID' }] });
  });

  it('replays the first response for a retry (one approval request), refuses the key with another body, scopes keys per admin', async () => {
    const grantee = await seedAdmin(`idem-${randomUUID().slice(0, 8)}`);
    const maker = await login('sec-a');
    const key = randomUUID();
    const body = { adminUserId: grantee, roleCode: 'AUDITOR', scope: { kind: 'GLOBAL' } };
    const first = await req(maker, 'POST', '/admin/v1/grants', body, { 'idempotency-key': key });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const retry = await req(maker, 'POST', '/admin/v1/grants', { scope: { kind: 'GLOBAL' }, roleCode: 'AUDITOR', adminUserId: grantee }, { 'idempotency-key': key });
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await approvals(grantee)).toBe(1);

    const reused = await req(maker, 'POST', '/admin/v1/grants', { ...body, roleCode: 'FINANCE' }, { 'idempotency-key': key });
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
    expect(await approvals(grantee)).toBe(1);

    // The same key from another admin is a different request.
    const other = await login('sec-b');
    const theirs = await req(other, 'POST', '/admin/v1/grants', body, { 'idempotency-key': key });
    expect(theirs.status).toBe(202);
    expect(theirs.headers['idempotent-replay']).toBeUndefined();
    expect(await approvals(grantee)).toBe(2);

    // After the 24 h retention the key may be used again as a new request.
    clock.advance(24 * 3_600_000 + 1_000);
    const later = await login('sec-a');
    const again = await req(later, 'POST', '/admin/v1/grants', body, { 'idempotency-key': key });
    expect(again.status).toBe(202);
    expect(again.headers['idempotent-replay']).toBeUndefined();
    expect((again.body as { approvalRequestId: string }).approvalRequestId).not.toBe((first.body as { approvalRequestId: string }).approvalRequestId);
  });

  it('concurrent duplicates create one approval request; the other is replayed or told to retry (409)', async () => {
    const grantee = await seedAdmin(`idem-${randomUUID().slice(0, 8)}`);
    const maker = await login('sec-a');
    const key = randomUUID();
    const body = { adminUserId: grantee, roleCode: 'AUDITOR', scope: { kind: 'GLOBAL' } };
    const results = await Promise.all([1, 2, 3].map(() => req(maker, 'POST', '/admin/v1/grants', body, { 'idempotency-key': key })));
    for (const r of results) expect([202, 409], JSON.stringify(r.body)).toContain(r.status);
    const ids = new Set(results.filter((r) => r.status === 202).map((r) => (r.body as { approvalRequestId: string }).approvalRequestId));
    expect(ids.size).toBe(1);
    expect(await approvals(grantee)).toBe(1);
  });

  it('an in-flight key held by another open transaction answers REQUEST_IN_PROGRESS with Retry-After', async () => {
    const grantee = await seedAdmin(`idem-${randomUUID().slice(0, 8)}`);
    const maker = await login('sec-a');
    const key = randomUUID();
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`INSERT INTO platform.idempotency_keys (actor_key, idem_key, endpoint, request_hash, status, created_at, expires_at)
        VALUES ($1, $2, 'POST /admin/v1/grants', $3, 'IN_FLIGHT', now(), now() + interval '1 day')`, [`admin:${admins['sec-a']}`, key, randomBytes(32)]);
      const r = await req(maker, 'POST', '/admin/v1/grants', { adminUserId: grantee, roleCode: 'AUDITOR', scope: { kind: 'GLOBAL' } }, { 'idempotency-key': key });
      expect(r.body).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
      expect(r.headers['retry-after']).toBe('1');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await approvals(grantee)).toBe(0);
  });
});

describe('admin actions on user sessions (matrix "Revoke sessions": SUP-L2 user (reason), SAF user, SEC ✅)', () => {
  it('needs security.sessions.revoke and a reason code', async () => {
    const userId = newId();
    await db.migrator.query("INSERT INTO identity.users (id, phone_masked, preferred_locale, status) VALUES ($1, '+91 ••••• •••99', 'te-IN', 'ACTIVE')", [userId]);
    const sessionId = newId();
    await db.migrator.query(`INSERT INTO identity.sessions (id, user_id, surface, auth_methods, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, 'TECHNICIAN_APP', '{otp}', now() + interval '1 day', now() + interval '2 days')`, [sessionId, userId]);
    const sec = await login('sec-a');
    const secActor = await app.backoffice.authenticate({ method: 'GET', proxyAssertion: sec.assertion, cookieHeader: sec.cookie, origin: undefined, csrfHeader: undefined });
    await expect(app.identity.revokeSession(secActor, sessionId, meta())).rejects.toMatchObject({ code: 'FORBIDDEN' }); // no reason
    const support = await login('sec-c'); // SUPPORT_L1: no revoke permission
    const supportActor = await app.backoffice.authenticate({ method: 'GET', proxyAssertion: support.assertion, cookieHeader: support.cookie, origin: undefined, csrfHeader: undefined });
    await expect(app.identity.revokeSession(supportActor, sessionId, meta(), 'ACCOUNT_COMPROMISE')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await app.identity.revokeSession(secActor, sessionId, meta(), 'ACCOUNT_COMPROMISE');
    const s = (await db.admin.query('SELECT revoke_reason FROM identity.sessions WHERE id = $1', [sessionId])).rows[0];
    expect(s.revoke_reason).toBe('ACCOUNT_COMPROMISE');
  });
});

describe('authorization matrix (Phase 1 05 §11, 13 §4)', () => {
  const ROLE_FOR: Partial<Record<MatrixColumn, string>> = {
    'SUP-L1': 'SUPPORT_L1', 'SUP-L2': 'SUPPORT_L2', DISP: 'DISPATCH', VER: 'VERIFICATION_OFFICER', SAF: 'SAFETY_OFFICER', FIN: 'FINANCE',
    CM: 'CITY_MANAGER', PRC: 'PRICING_ADMIN', AUD: 'AUDITOR', SEC: 'SECURITY_ADMIN',
  };

  async function actorFor(column: MatrixColumn): Promise<Actor> {
    const id = `actor-${column}`;
    switch (column) {
      case 'CUS': return { kind: 'CUSTOMER', id, sessionId: `s-${id}`, surface: 'CUSTOMER_WEB' };
      case 'TEC-APP': return { kind: 'TECHNICIAN', id, sessionId: `s-${id}`, surface: 'TECHNICIAN_APP' };
      case 'TEC-IVR': return { kind: 'TECHNICIAN', id, sessionId: `s-${id}`, surface: 'TECHNICIAN_IVR' };
      case 'AGT': return { kind: 'FIELD_AGENT', id, sessionId: `s-${id}`, surface: 'AGENT_WEB' };
      default: {
        const role = ROLE_FOR[column];
        const rows = role ? (await db.admin.query('SELECT permission FROM backoffice.role_permissions WHERE role_code = $1', [role])).rows : [];
        return { kind: 'ADMIN', id, sessionId: `s-${id}`, surface: 'ADMIN', stepUpAt: clock.now(),
          permissions: new Map(rows.map((r) => [r.permission as string, [{ kind: 'GLOBAL' as const }]])) };
      }
    }
  }

  const implemented = [
    { capability: 'Revoke sessions', action: 'identity.session.revoke', pendingColumns: { 'SUPER (BG)': 'break-glass access (05 §9) is not a Gate 3 deliverable' } },
    { capability: 'Grant roles', action: 'backoffice.grant.request', pendingColumns: { 'SUPER (BG)': 'break-glass access (05 §9) is not a Gate 3 deliverable' } },
  ] as const;
  const cases = generateMatrixCases(implemented);

  it('covers every cell of the V1 matrix', () => {
    expect(cases).toHaveLength(38 * MATRIX_COLUMNS.length);
    expect(cases.filter((c) => c.mode === 'implemented')).toHaveLength(2 * (MATRIX_COLUMNS.length - 1));
  });

  it.each(cases.filter((c) => c.mode === 'implemented').map((c) => [`${c.capability} / ${c.column} = ${c.cell}`, c] as const))(
    'implemented: %s', async (_name, c) => {
      const actor = await actorFor(c.column);
      const impl = implemented.find((i) => i.capability === c.capability);
      const resource = c.capability === 'Revoke sessions'
        ? { ownerUserId: actor.kind === 'ADMIN' ? 'some-user' : actor.id, reasonCode: actor.kind === 'ADMIN' ? 'SUPPORT_REQUEST' : null }
        : { granteeId: 'someone-else', requesterId: actor.id ?? null };
      expect(app.policies.can(actor, impl?.action ?? '', resource, { now: clock.now() }).allow).toBe(c.expectAllow);
      // Own / relationship-scoped cells: an object outside the actor's relationship is denied (404).
      if (c.capability === 'Revoke sessions' && actor.kind !== 'ADMIN' && c.expectAllow) {
        expect(app.policies.can(actor, impl?.action ?? '', { ownerUserId: 'someone-else', reasonCode: null }, { now: clock.now() })).toMatchObject({ allow: false, status: 404 });
      }
    });

  it('every pending cell is denied by default (no policy, or out-of-scope mechanism)', async () => {
    const pending = cases.filter((c) => c.mode === 'pending');
    expect(pending.length).toBe(36 * MATRIX_COLUMNS.length + 2);
    for (const c of pending) {
      const actor = await actorFor(c.column === 'SUPER (BG)' ? 'SEC' : c.column);
      const impl = implemented.find((i) => i.capability === c.capability);
      const action = impl && c.column !== 'SUPER (BG)' ? impl.action : placeholderAction(c.capability);
      expect(app.policies.can(c.column === 'SUPER (BG)' ? { kind: 'ADMIN', id: 'break-glass' } : actor, impl ? impl.action : action, {}, { now: clock.now() }).allow,
        `${c.capability} / ${c.column}`).toBe(false);
    }
  });
});
