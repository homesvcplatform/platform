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
import { BACKOFFICE_SQL, canonicalJson } from '@hsp/module-backoffice';
import { MemoryRateLimitStore, sha256 } from '@hsp/security';
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

type Operation = 'security.grant.decide' | 'backoffice.passkey.register';

/** Starts a step-up (no assertion yet). For a grant decision the decision defaults to APPROVE. */
async function stepUpOptions(s: AdminSession, operation: Operation, approvalRequestId?: string, decision?: 'APPROVE' | 'REJECT') {
  const body = { operation, ...(approvalRequestId ? { approvalRequestId, decision: decision ?? 'APPROVE' } : {}) };
  const opt = await req(s, 'POST', '/admin/v1/step-up/options', body);
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  return opt.body as { challengeId: string; challenge: string };
}

/** Passkey step-up for one operation (and approval request + decision). Returns the response and the single-use `stepUpId`. */
async function stepUp(s: AdminSession, authenticator: SoftAuthenticator, operation: Operation, approvalRequestId?: string, decision?: 'APPROVE' | 'REJECT') {
  const opt = await req(s, 'POST', '/admin/v1/step-up/options', { operation, ...(approvalRequestId ? { approvalRequestId, decision: decision ?? 'APPROVE' } : {}) });
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
  const a = authenticator.assert(challenge);
  const res = await req(s, 'POST', '/admin/v1/step-up', { challengeId, credentialId: a.credentialId, clientDataJSON: a.clientDataJSON.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'), signature: a.signature.toString('base64url') });
  return { res, stepUpId: (res.body as { stepUpId?: string } | undefined)?.stepUpId ?? '' };
}

async function beginRegistration(s: AdminSession) {
  const opt = await req(s, 'POST', '/admin/v1/passkeys/registration-options', {});
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  return opt.body as { challengeId: string; challenge: string };
}

function finishRegistration(s: AdminSession, authenticator: SoftAuthenticator, opt: { challengeId: string; challenge: string }) {
  const reg = authenticator.register(opt.challenge);
  return req(s, 'POST', '/admin/v1/passkeys', { challengeId: opt.challengeId, clientDataJSON: reg.clientDataJSON.toString('base64url'),
    attestationObject: reg.attestationObject.toString('base64url') });
}

async function registerPasskey(s: AdminSession, stepUpId?: string): Promise<SoftAuthenticator> {
  const authenticator = createSoftAuthenticator(RP_ID, ORIGIN);
  const opt = await req(s, 'POST', '/admin/v1/passkeys/registration-options', stepUpId ? { stepUpId } : {});
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
    appEnv: 'test', rateLimitStore: new MemoryRateLimitStore(),
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
    const body = { operation: 'backoffice.passkey.register' };
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
  it('registers the first passkey right after login, then requires a step-up bound to passkey registration (single use); assertions are verified', async () => {
    const s = await login('sec-c');
    const key = await registerPasskey(s);
    // A second passkey needs a step-up bound to this operation.
    expect((await req(s, 'POST', '/admin/v1/passkeys/registration-options', {})).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const up = await stepUp(s, key, 'backoffice.passkey.register');
    expect(up.res.status).toBe(200);
    expect((await req(s, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: up.stepUpId })).status).toBe(200);
    expect((await req(s, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: up.stepUpId })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' }); // used
    // Only server-defined operations can be requested.
    expect((await req(s, 'POST', '/admin/v1/step-up/options', { operation: 'security.grant.approve' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await req(s, 'POST', '/admin/v1/step-up/options', { operation: 'admin.anything' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    // A different authenticator, a replayed challenge or a wrong origin are refused.
    expect((await stepUp(s, createSoftAuthenticator(RP_ID, ORIGIN), 'backoffice.passkey.register')).res.status).toBe(401);
    const opt = await req(s, 'POST', '/admin/v1/step-up/options', { operation: 'backoffice.passkey.register' });
    const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
    const bad = key.assert(challenge, { origin: 'https://evil.invalid' });
    const send = (a: ReturnType<SoftAuthenticator['assert']>) => req(s, 'POST', '/admin/v1/step-up', { challengeId, credentialId: a.credentialId,
      clientDataJSON: a.clientDataJSON.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'), signature: a.signature.toString('base64url') });
    expect((await send(bad)).status).toBe(401);
    expect((await send(key.assert(challenge))).status).toBe(401); // challenge consumed by the failed attempt
  });

  it('a stale first-passkey challenge can not enrol a second passkey (re-checked under the admin lock at completion)', async () => {
    await seedAdmin('first-race');
    const s = await login('first-race');
    const one = await beginRegistration(s);
    const two = await beginRegistration(s); // also issued under the first-passkey exemption
    expect((await finishRegistration(s, createSoftAuthenticator(RP_ID, ORIGIN), one)).status).toBe(201);
    expect((await finishRegistration(s, createSoftAuthenticator(RP_ID, ORIGIN), two)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const n = await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_webauthn_credentials WHERE admin_user_id = $1', [admins['first-race']]);
    expect(n.rows[0].n).toBe(1);
    const modes = await db.admin.query("SELECT DISTINCT enrollment_mode FROM backoffice.webauthn_challenges WHERE admin_user_id = $1 AND purpose = 'REGISTRATION'", [admins['first-race']]);
    expect(modes.rows.map((r) => r.enrollment_mode)).toEqual(['FIRST_PASSKEY']);
  });

  it('two first-passkey completions at the same time enrol exactly one passkey', async () => {
    await seedAdmin('first-race-2');
    const s = await login('first-race-2');
    const opts = [await beginRegistration(s), await beginRegistration(s), await beginRegistration(s)];
    const results = await Promise.all(opts.map((o) => finishRegistration(s, createSoftAuthenticator(RP_ID, ORIGIN), o)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect(r.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const n = await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_webauthn_credentials WHERE admin_user_id = $1', [admins['first-race-2']]);
    expect(n.rows[0].n).toBe(1);
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
    const decide = (s: AdminSession, stepUpId: string, decision = 'APPROVE') =>
      req(s, 'POST', `/admin/v1/approvals/${id}/decision`, { decision, stepUpId });
    expect((await decide(maker, randomUUID())).body).toMatchObject({ code: 'FORBIDDEN' }); // maker can't check
    // The maker can't even start a step-up for its own request.
    expect((await req(maker, 'POST', '/admin/v1/step-up/options', { operation: 'security.grant.decide', approvalRequestId: id })).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await decide(checker, randomUUID())).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await req(checker, 'POST', `/admin/v1/approvals/${id}/decision`, { decision: 'APPROVE' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const up = await stepUp(checker, checkerKey, 'security.grant.decide', id);
    expect(up.res.status).toBe(200);
    expect((await decide(checker, up.stepUpId)).status).toBe(204);
    expect((await decide(checker, up.stepUpId)).body).toMatchObject({ code: 'INVALID_STATE' }); // executed exactly once
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
    const up = await stepUp(checker, checkerKey, 'security.grant.decide', id);
    expect(up.res.status).toBe(200);
    const out = await req(checker, 'POST', `/admin/v1/approvals/${id}/decision`, { decision: 'APPROVE', stepUpId: up.stepUpId });
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

describe('action-bound step-up (SR-03, 05 §2.5)', () => {
  const newRequest = async (maker: AdminSession, roleCode = 'AUDITOR') => {
    const grantee = await seedAdmin(`bound-${randomUUID().slice(0, 8)}`);
    const r = await req(maker, 'POST', '/admin/v1/grants', { adminUserId: grantee, roleCode, scope: { kind: 'GLOBAL' } }, { 'idempotency-key': randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return { id: (r.body as { approvalRequestId: string }).approvalRequestId, grantee };
  };
  const decide = (s: AdminSession, id: string, stepUpId: string, decision: 'APPROVE' | 'REJECT' = 'APPROVE') =>
    req(s, 'POST', `/admin/v1/approvals/${id}/decision`, { decision, stepUpId });
  const statusOf = async (id: string) => ((await db.admin.query('SELECT status FROM backoffice.approval_requests WHERE id = $1', [id])).rows[0].status as string);
  const usedAt = async (stepUpId: string) => ((await db.admin.query('SELECT used_at FROM backoffice.webauthn_challenges WHERE id = $1', [stepUpId])).rows[0]?.used_at ?? null);
  const grantCount = async (grantee: string) =>
    ((await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_grants WHERE admin_user_id = $1', [grantee])).rows[0].n as number);
  let maker: AdminSession;
  let checker: AdminSession;
  let key: SoftAuthenticator;
  beforeAll(async () => {
    if (!checkerKey) throw new Error('the maker-checker test registers the checker passkey');
    key = checkerKey;
  });
  const sessions = async () => {
    maker = await login('sec-a');
    checker = await login('sec-b');
  };

  it('a step-up for another operation can not authorise a decision, and vice versa', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const other = await stepUp(checker, key, 'backoffice.passkey.register');
    expect((await decide(checker, id, other.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const forDecision = await stepUp(checker, key, 'security.grant.decide', id);
    expect((await req(checker, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: forDecision.stepUpId })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await grantCount(grantee)).toBe(0);
  });

  it('a step-up bound to one approval request can not approve another', async () => {
    await sessions();
    const a = await newRequest(maker);
    const b = await newRequest(maker);
    const forA = await stepUp(checker, key, 'security.grant.decide', a.id);
    expect((await decide(checker, b.id, forA.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await grantCount(b.grantee)).toBe(0);
    expect((await decide(checker, a.id, forA.stepUpId)).status).toBe(204); // still valid for its own request
  });

  it('a payload changed after the step-up (consistently re-hashed) invalidates it', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const up = await stepUp(checker, key, 'security.grant.decide', id);
    const changed = { adminUserId: grantee, roleCode: 'FINANCE', scope: { kind: 'GLOBAL' }, expiresAt: null };
    await db.migrator.query('UPDATE backoffice.approval_requests SET payload = $2, payload_hash = $3 WHERE id = $1',
      [id, JSON.stringify(changed), sha256(canonicalJson(changed))]);
    expect((await decide(checker, id, up.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await grantCount(grantee)).toBe(0);
  });

  it('expires 5 minutes after the assertion, and belongs to the session that performed it', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const up = await stepUp(checker, key, 'security.grant.decide', id);
    const relogin = await login('sec-b'); // the new session can't use the old session's step-up
    checker = relogin;
    expect((await decide(checker, id, up.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const fresh = await stepUp(checker, key, 'security.grant.decide', id);
    clock.advance(5 * 60_000 + 1_000);
    const late = { ...checker, assertion: await idp.mint('sec-b', { now: clock.now() }) };
    expect((await decide(late, id, fresh.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await grantCount(grantee)).toBe(0);
  });

  it('binds the decision: an APPROVE step-up can not reject and a REJECT step-up can not approve', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const forApprove = await stepUp(checker, key, 'security.grant.decide', id, 'APPROVE');
    expect((await decide(checker, id, forApprove.stepUpId, 'REJECT')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const forReject = await stepUp(checker, key, 'security.grant.decide', id, 'REJECT');
    expect((await decide(checker, id, forReject.stepUpId, 'APPROVE')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await statusOf(id)).toBe('PENDING');
    expect(await usedAt(forApprove.stepUpId)).toBeNull();
    expect(await usedAt(forReject.stepUpId)).toBeNull();
    expect(await grantCount(grantee)).toBe(0);
    // A decide step-up without a decision is refused at issue.
    expect((await req(checker, 'POST', '/admin/v1/step-up/options', { operation: 'security.grant.decide', approvalRequestId: id })).body)
      .toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'decision', code: 'REQUIRED' }] });
    const audit = await db.admin.query("SELECT change_summary FROM compliance.audit_logs WHERE action = 'admin.step_up' AND change_summary->>'decision' = 'REJECT'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('REJECT requires a step-up bound to REJECT, consumes it and creates no grant', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    expect((await decide(checker, id, randomUUID(), 'REJECT')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await req(checker, 'POST', `/admin/v1/approvals/${id}/decision`, { decision: 'REJECT' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const up = await stepUp(checker, key, 'security.grant.decide', id, 'REJECT');
    expect((await decide(checker, id, up.stepUpId, 'REJECT')).status).toBe(204);
    expect(await statusOf(id)).toBe('REJECTED');
    expect(await usedAt(up.stepUpId)).not.toBeNull();
    expect(await grantCount(grantee)).toBe(0);
    expect((await decide(checker, id, up.stepUpId, 'REJECT')).body).toMatchObject({ code: 'INVALID_STATE' });
    const decided = await db.admin.query("SELECT change_summary->>'decision' AS d FROM compliance.audit_logs WHERE action = 'approval.decided' AND resource_id = $1", [id]);
    expect(decided.rows.map((r) => r.d)).toEqual(['REJECT']);
  });

  it('refuses an unverified step-up and one whose assertion failed', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const unverified = await stepUpOptions(checker, 'security.grant.decide', id);
    expect((await decide(checker, id, unverified.challengeId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const failed = await stepUpOptions(checker, 'security.grant.decide', id);
    const bad = key.assert(failed.challenge, { origin: 'https://evil.invalid' });
    const res = await req(checker, 'POST', '/admin/v1/step-up', { challengeId: failed.challengeId, credentialId: bad.credentialId,
      clientDataJSON: bad.clientDataJSON.toString('base64url'), authenticatorData: bad.authenticatorData.toString('base64url'), signature: bad.signature.toString('base64url') });
    expect(res.status).toBe(401);
    expect((await decide(checker, id, failed.challengeId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // Same for passkey registration.
    const regUnverified = await stepUpOptions(checker, 'backoffice.passkey.register');
    expect((await req(checker, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: regUnverified.challengeId })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await statusOf(id)).toBe('PENDING');
    expect(await grantCount(grantee)).toBe(0);
  });

  it("refuses another admin's step-up, even for the same request and decision", async () => {
    await sessions();
    await seedAdmin('sec-d');
    await seedGrant('sec-d', 'SECURITY_ADMIN', 'sec-a', 'sec-b');
    const other = await login('sec-d');
    const otherKey = await registerPasskey(other);
    const { id, grantee } = await newRequest(maker);
    const theirs = await stepUp(other, otherKey, 'security.grant.decide', id);
    expect(theirs.res.status).toBe(200);
    expect((await decide(checker, id, theirs.stepUpId)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await grantCount(grantee)).toBe(0);
    expect((await decide(other, id, theirs.stepUpId)).status).toBe(204); // valid for its owner
  });

  it('concurrent decisions with one step-up: the grant executes once (serialised by the approval row lock, not by the step-up guard)', async () => {
    await sessions();
    const { id, grantee } = await newRequest(maker);
    const up = await stepUp(checker, key, 'security.grant.decide', id);
    const results = await Promise.all([1, 2, 3].map(() => decide(checker, id, up.stepUpId)));
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 204)) expect(['INVALID_STATE', 'STEP_UP_REQUIRED']).toContain((r.body as { code: string }).code);
    expect(await grantCount(grantee)).toBe(1);
    const used = (await db.admin.query('SELECT used_at FROM backoffice.webauthn_challenges WHERE id = $1', [up.stepUpId])).rows[0];
    expect(used.used_at).not.toBeNull();
  });

  it('simultaneous registration-option requests with one step-up: exactly one succeeds (serialised by the challenge row lock)', async () => {
    await sessions();
    const up = await stepUp(checker, key, 'backoffice.passkey.register');
    const results = await Promise.all([1, 2, 3, 4].map(() => req(checker, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: up.stepUpId })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('database: B waits on A\'s row lock (proven via pg_blocking_pids), then its single-use UPDATE affects no row', async () => {
    await sessions();
    const up = await stepUp(checker, key, 'backoffice.passkey.register');
    const row = (await db.admin.query('SELECT admin_user_id, session_id FROM backoffice.webauthn_challenges WHERE id = $1', [up.stepUpId])).rows[0];
    const params = [up.stepUpId, clock.now(), 'backoffice.passkey.register', row.admin_user_id, row.session_id,
      new Date(clock.now().getTime() - 5 * 60_000), null, null, null];
    const a = await pool.connect();
    const b = await pool.connect();
    let aOpen = false;
    let bOpen = false;
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('BEGIN');
      aOpen = true;
      await b.query('BEGIN');
      bOpen = true;
      const aPid = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      const bPid = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      const first = await a.query(BACKOFFICE_SQL.markUsed, params);
      expect(first.rowCount).toBe(1);
      const second = b.query(BACKOFFICE_SQL.markUsed, params);
      pending = second.catch(() => undefined);
      // Evidence that B is blocked by A (bounded wait: up to 5 s).
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        blocked = (await db.admin.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS w', [bPid, aPid])).rows[0].w === true;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      await a.query('COMMIT');
      aOpen = false;
      const secondResult = await second; // re-evaluated after A commits: used_at is no longer NULL
      await b.query('COMMIT');
      bOpen = false;
      expect(secondResult.rowCount).toBe(0);
    } finally {
      if (aOpen) await a.query('ROLLBACK').catch(() => undefined);
      await pending;
      if (bOpen) await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('database: the single-use UPDATE refuses every ineligible binding', async () => {
    await sessions();
    const { id } = await newRequest(maker);
    const up = await stepUp(checker, key, 'security.grant.decide', id, 'APPROVE');
    const row = (await db.admin.query('SELECT admin_user_id, session_id, payload_hash, verified_at FROM backoffice.webauthn_challenges WHERE id = $1', [up.stepUpId])).rows[0];
    const now = clock.now();
    const base: unknown[] = [up.stepUpId, now, 'security.grant.decide', row.admin_user_id, row.session_id, new Date(now.getTime() - 5 * 60_000),
      id, row.payload_hash, 'APPROVE'];
    const withParam = (i: number, v: unknown) => base.map((x, j) => (j === i ? v : x));
    const unverified = await stepUpOptions(checker, 'security.grant.decide', id, 'APPROVE');
    const registration = await req(checker, 'POST', '/admin/v1/passkeys/registration-options', { stepUpId: (await stepUp(checker, key, 'backoffice.passkey.register')).stepUpId });
    const regId = (registration.body as { challengeId: string }).challengeId;
    const tries: [string, unknown[]][] = [
      ['wrong operation', withParam(2, 'backoffice.passkey.register')],
      ['another admin', withParam(3, admins['sec-a'])],
      ['another session', withParam(4, randomUUID())],
      ['too old', withParam(5, new Date(now.getTime() + 1_000))],
      ['verified after "now"', withParam(1, new Date(new Date(row.verified_at).getTime() - 1_000))],
      ['another approval request', withParam(6, randomUUID())],
      ['another payload hash', withParam(7, randomBytes(32))],
      ['NULL payload hash', withParam(7, null)],
      ['another decision', withParam(8, 'REJECT')],
      ['NULL decision', withParam(8, null)],
      ['unverified challenge', withParam(0, unverified.challengeId)],
      ['registration challenge', withParam(0, regId)],
    ];
    for (const [name, t] of tries) expect((await pool.query(BACKOFFICE_SQL.markUsed, t)).rowCount, name).toBe(0);
    expect((await pool.query(BACKOFFICE_SQL.markUsed, base)).rowCount).toBe(1);
    expect((await pool.query(BACKOFFICE_SQL.markUsed, base)).rowCount).toBe(0); // single use
  });

  it('database: the binding CHECK refuses incomplete or contradictory challenge rows (NULLs included)', async () => {
    const admin = admins['sec-b'];
    const session = (await db.admin.query('SELECT id FROM backoffice.admin_sessions WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1', [admin])).rows[0].id;
    const ins = (cols: Record<string, unknown>) => {
      const all: Record<string, unknown> = { id: newId(), admin_user_id: admin, session_id: session, challenge_hash: randomBytes(32),
        expires_at: new Date(Date.now() + 60_000), ...cols };
      const keys = Object.keys(all);
      return db.migrator.query(`INSERT INTO backoffice.webauthn_challenges (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(all));
    };
    const decideRow = { purpose: 'STEP_UP', action: 'security.grant.decide', resource_id: newId(), payload_hash: randomBytes(32), decision: 'APPROVE' };
    await expect(ins(decideRow)).resolves.toBeDefined();
    const bad: [string, Record<string, unknown>][] = [
      ['decide with NULL payload_hash', { ...decideRow, payload_hash: null }],
      ['decide with a short payload_hash', { ...decideRow, payload_hash: randomBytes(16) }],
      ['decide with NULL resource_id', { ...decideRow, resource_id: null }],
      ['decide with NULL decision', { ...decideRow, decision: null }],
      ['decide with an unknown decision', { ...decideRow, decision: 'MAYBE' }],
      ['passkey.register with a decision', { purpose: 'STEP_UP', action: 'backoffice.passkey.register', decision: 'APPROVE' }],
      ['passkey.register with a resource', { purpose: 'STEP_UP', action: 'backoffice.passkey.register', resource_id: newId() }],
      ['unknown operation', { purpose: 'STEP_UP', action: 'security.grant.approve' }],
      ['registration without enrollment_mode', { purpose: 'REGISTRATION' }],
      ['registration with an unknown enrollment_mode', { purpose: 'REGISTRATION', enrollment_mode: 'ANY' }],
      ['step-up with an enrollment_mode', { purpose: 'STEP_UP', action: 'backoffice.passkey.register', enrollment_mode: 'STEP_UP' }],
      ['registration marked verified', { purpose: 'REGISTRATION', enrollment_mode: 'FIRST_PASSKEY', consumed_at: new Date(), verified_at: new Date() }],
      ['used without verified', { purpose: 'STEP_UP', action: 'backoffice.passkey.register', consumed_at: new Date(), used_at: new Date() }],
      ['verified without consumed', { purpose: 'STEP_UP', action: 'backoffice.passkey.register', verified_at: new Date() }],
    ];
    for (const [name, cols] of bad) await expect(ins(cols), name).rejects.toMatchObject({ code: '23514' });
  });
});

describe('security permission scope (05 §5.3: security administration is global)', () => {
  it('global-only roles can not be granted per city: refused by the API and by the database', async () => {
    const maker = await login('sec-a');
    const cityScope = { kind: 'CITIES', cityIds: ['0190f0aa-0000-7000-8000-00000000c1c1'] };
    for (const roleCode of ['SECURITY_ADMIN', 'FINANCE', 'AUDITOR']) {
      const r = await req(maker, 'POST', '/admin/v1/grants', { adminUserId: admins['nobody'], roleCode, scope: cityScope }, { 'idempotency-key': randomUUID() });
      expect(r.body, roleCode).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'scope', code: 'GLOBAL_ONLY_ROLE' }] });
    }
    for (const roleCode of ['SECURITY_ADMIN', 'FINANCE', 'AUDITOR']) {
      const approval = newId();
      await db.migrator.query(
        `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, resource_id, payload, payload_hash, risk_level, requested_by_admin_id,
           required_approver_permission, decided_by_admin_id, decided_at, status, expires_at)
         VALUES ($1, 'security.grant', 'backoffice.admin_user', $2, '{}', $3, 'HIGH', $4, 'security.grant.approve', $5, now(), 'EXECUTED', now() + interval '1 day')`,
        [approval, admins['nobody'], randomBytes(32), admins['sec-a'], admins['sec-b']]);
      await expect(db.migrator.query(
        `INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, city_ids, granted_by_admin_id, approved_by_admin_id, approval_request_id)
         VALUES ($1, $2, $3, 'CITIES', ARRAY['0190f0aa-0000-7000-8000-00000000c1c1']::uuid[], $4, $5, $6)`,
        [newId(), admins['nobody'], roleCode, admins['sec-a'], admins['sec-b'], approval]), roleCode).rejects.toMatchObject({ code: 'HS020' });
    }
  });

  it('the scope trigger also guards UPDATE: a global grant can not be narrowed to cities, nor a city grant moved to a global-only role', async () => {
    const globalGrant = (await db.admin.query("SELECT id FROM backoffice.admin_grants WHERE role_code = 'SECURITY_ADMIN' AND scope_kind = 'GLOBAL' LIMIT 1")).rows[0].id;
    await expect(db.migrator.query("UPDATE backoffice.admin_grants SET scope_kind = 'CITIES', city_ids = ARRAY['0190f0aa-0000-7000-8000-00000000c1c1']::uuid[] WHERE id = $1",
      [globalGrant])).rejects.toMatchObject({ code: 'HS020' });
    const cityGrant = (await db.admin.query("SELECT id FROM backoffice.admin_grants WHERE role_code = 'SUPPORT_L1' AND scope_kind = 'CITIES' LIMIT 1")).rows[0].id;
    for (const role of ['SECURITY_ADMIN', 'FINANCE', 'AUDITOR']) {
      await expect(db.migrator.query('UPDATE backoffice.admin_grants SET role_code = $2 WHERE id = $1', [cityGrant, role]), role).rejects.toMatchObject({ code: 'HS020' });
    }
    await expect(db.migrator.query("UPDATE backoffice.admin_grants SET role_code = 'DISPATCH' WHERE id = $1", [cityGrant])).resolves.toBeDefined();
    await db.migrator.query("UPDATE backoffice.admin_grants SET role_code = 'SUPPORT_L1' WHERE id = $1", [cityGrant]);
  });

  it('every role holding a security-administration permission is global-only (DB)', async () => {
    const r = await db.admin.query(`SELECT DISTINCT r.code, r.global_only FROM backoffice.role_permissions p JOIN backoffice.roles r ON r.code = p.role_code
      WHERE p.permission IN ('security.grant', 'security.grant.approve', 'security.access_review') OR p.permission = 'security.*'`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.global_only, row.code).toBe(true);
  });

  it('a city-scoped security permission (if a role ever carried one) authorises no security administration', async () => {
    const cityAdmin = { kind: 'ADMIN' as const, id: admins['nobody'] ?? '', sessionId: 's', surface: 'ADMIN' as const,
      permissions: new Map([['security.grant', [{ kind: 'CITIES' as const, cityIds: ['0190f0aa-0000-7000-8000-00000000c1c1'] }]],
        ['security.grant.approve', [{ kind: 'CITIES' as const, cityIds: ['0190f0aa-0000-7000-8000-00000000c1c1'] }]]]) };
    await expect(app.backoffice.requestGrant(cityAdmin, { adminUserId: admins['auditor-x'] ?? '', roleCode: 'SUPPORT_L1', scope: { kind: 'GLOBAL' } }, randomUUID(), meta()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('single active admin session under concurrency (05 §2.5)', () => {
  it('simultaneous logins of one admin leave exactly one active session', async () => {
    const name = `conc-${randomUUID().slice(0, 8)}`;
    await seedAdmin(name);
    const results = await Promise.all(Array.from({ length: 6 }, async () =>
      app.http({ method: 'POST', path: '/admin/v1/session', headers: { 'x-proxy-assertion': await idp.mint(name, { now: clock.now() }) }, meta: meta() })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const active = await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL', [admins[name]]);
    expect(active.rows[0].n).toBe(1);
    const all = await db.admin.query('SELECT count(*)::int AS n FROM backoffice.admin_sessions WHERE admin_user_id = $1', [admins[name]]);
    expect(all.rows[0].n).toBe(6);
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
