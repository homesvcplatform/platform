// Gate 4 exit criteria through the admin realm (ADR-025 #4–#7, 05 §5.4, INV-19): a city service rule and a city's
// languages change only through a two-person approved change request (maker with the maker permission for the city;
// a different checker with the checker permission for the city and a passkey step-up bound to the request, its payload
// hash and the decision). An approved change shows up in the public catalog without a restart or deploy. A missing
// translation blocks enabling a locale. Throwaway database, synthetic admins and cities, test IdP, software passkeys.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralKeyring, createLocalTokenSigningKey } from '@hsp/adapter-kms-local';
import { ManualClock, newId } from '@hsp/kernel';
import type { CatalogIssue } from '@hsp/localization';
import { isKnownPermissionEntry } from '@hsp/module-backoffice';
import { CatalogService, registerCatalogPolicies, serviceRulesChangeAction } from '@hsp/module-catalog';
import { cityLocalesChangeAction, GeoService, registerGeoPolicies, repositoryCatalogIssues } from '@hsp/module-geo';
import { createLogger } from '@hsp/observability';
import { AUTHZ_MATRIX, MATRIX_COLUMNS, PolicyRegistry, type Actor, type MatrixColumn } from '@hsp/policy';
import { createRateLimiter, MemoryRateLimitStore } from '@hsp/security';
import { createSoftAuthenticator, createTestDatabase, createTestIdp, kurnool, loadSyntheticSeed, type SoftAuthenticator, type TestDatabase } from '@hsp/testing';
import { composeAdminApi } from '../bootstrap.ts';

const ORIGIN = 'https://admin.test.invalid';
const RP_ID = 'admin.test.invalid';
const { CITY, serviceTypeId } = kurnool;
const OTHER_CITY = newId();
const LOCALE_CITY = newId();

let db: TestDatabase;
let pool: pg.Pool;
let apiPool: pg.Pool;
let app: ReturnType<typeof composeAdminApi>;
let publicCatalog: CatalogService;
let issuesOverride: CatalogIssue[] | undefined;
const clock = new ManualClock(new Date());
/** The public catalog reads on its own clock, so moving read time forward doesn't idle-expire the admin sessions (30 min). */
const readClock = new ManualClock(clock.now());
const idp = createTestIdp();
const logs: string[] = [];
const admins: Record<string, string> = {};
const meta = () => ({ requestId: randomUUID(), clientIp: '10.20.0.9' });

interface AdminSession { cookie: string; csrf: string; assertion: string; name: string; key?: SoftAuthenticator }

async function seedAdmin(name: string): Promise<string> {
  const id = newId();
  await db.migrator.query("INSERT INTO backoffice.admin_users (id, idp_subject, status) VALUES ($1, $2, 'ACTIVE')", [id, name]);
  admins[name] = id;
  return id;
}

async function seedGrant(grantee: string, role: string, scope: { kind: 'GLOBAL' } | { kind: 'CITIES'; cityIds: string[] }) {
  const approval = newId();
  await db.migrator.query(
    `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, resource_id, payload, payload_hash, risk_level, requested_by_admin_id,
       required_approver_permission, decided_by_admin_id, decided_at, status, expires_at)
     VALUES ($1, 'security.grant', 'backoffice.admin_user', $2, '{}', $3, 'HIGH', $4, 'security.grant.approve', $5, now(), 'EXECUTED', now() + interval '1 day')`,
    [approval, admins[grantee], randomBytes(32), admins['fixture-maker'], admins['fixture-checker']]);
  await db.migrator.query(
    `INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, city_ids, granted_by_admin_id, approved_by_admin_id, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), admins[grantee], role, scope.kind, scope.kind === 'CITIES' ? scope.cityIds : [], admins['fixture-maker'], admins['fixture-checker'], approval]);
}

async function login(name: string): Promise<AdminSession> {
  const assertion = await idp.mint(name, { amr: ['hwk', 'user'], now: clock.now() });
  const r = await app.http({ method: 'POST', path: '/admin/v1/session', headers: { 'x-proxy-assertion': assertion }, meta: meta() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: (r.headers['set-cookie'] ?? '').split(';')[0] ?? '', csrf: (r.body as { csrfToken: string }).csrfToken, assertion, name };
}

const req = (s: AdminSession, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => app.http({
  method, path, body, meta: meta(),
  headers: { 'x-proxy-assertion': s.assertion, cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, ...extra },
});

/** Logs in and registers the first passkey (allowed right after a fresh login). */
async function checkerSession(name: string): Promise<AdminSession> {
  const s = await login(name);
  const key = createSoftAuthenticator(RP_ID, ORIGIN);
  const opt = (await req(s, 'POST', '/admin/v1/passkeys/registration-options', {})).body as { challengeId: string; challenge: string };
  const reg = key.register(opt.challenge);
  const done = await req(s, 'POST', '/admin/v1/passkeys', { challengeId: opt.challengeId, clientDataJSON: reg.clientDataJSON.toString('base64url'),
    attestationObject: reg.attestationObject.toString('base64url') });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  return { ...s, key };
}

async function propose(s: AdminSession, actionType: string, change: Record<string, unknown>, key: string = randomUUID()) {
  return req(s, 'POST', '/admin/v1/change-requests', { actionType, change }, { 'idempotency-key': key });
}

async function proposeOk(s: AdminSession, actionType: string, change: Record<string, unknown>): Promise<string> {
  const r = await propose(s, actionType, change);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return (r.body as { changeRequestId: string }).changeRequestId;
}

/** A change-decision step-up for this request and decision. Returns the HTTP status of the options call and the stepUpId. */
async function stepUp(s: AdminSession, changeRequestId: string, decision: 'APPROVE' | 'REJECT', operation = 'backoffice.change.decide') {
  const opt = await req(s, 'POST', '/admin/v1/step-up/options', { operation, approvalRequestId: changeRequestId, decision });
  if (opt.status !== 200 || !s.key) return { status: opt.status, stepUpId: '' };
  const { challengeId, challenge } = opt.body as { challengeId: string; challenge: string };
  const a = s.key.assert(challenge);
  const res = await req(s, 'POST', '/admin/v1/step-up', { challengeId, credentialId: a.credentialId, clientDataJSON: a.clientDataJSON.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'), signature: a.signature.toString('base64url') });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { status: 200, stepUpId: (res.body as { stepUpId: string }).stepUpId };
}

async function decide(s: AdminSession, changeRequestId: string, decision: 'APPROVE' | 'REJECT', stepUpId?: string) {
  const id = stepUpId ?? (await stepUp(s, changeRequestId, decision)).stepUpId;
  return req(s, 'POST', `/admin/v1/change-requests/${changeRequestId}/decision`, { decision, stepUpId: id });
}

let readCounter = 0;
async function offered(cityId: string = CITY.id): Promise<string[]> {
  readCounter += 1;
  const r = await publicCatalog.listCategories({ kind: 'ANONYMOUS' }, { cityId, locale: 'en-IN' }, { requestId: randomUUID(), clientIp: `192.0.2.${readCounter % 250}` });
  return r.categories.flatMap((c) => c.serviceTypes.map((t) => t.code)).sort();
}

const status = async (id: string) => (await db.migrator.query('SELECT status FROM backoffice.approval_requests WHERE id = $1', [id])).rows[0]?.status as string;
const ruleChange = (code: string, enabled: boolean, cityId: string | null = CITY.id, extra: Record<string, unknown> = {}) =>
  ({ serviceTypeId: serviceTypeId(code), cityId, rules: { enabled, same_visit_repair_allowed: true, quote_expiry_hours: 48 }, ...extra });

let prc: AdminSession; // PRICING_ADMIN, Kurnool
let cm: AdminSession; // CITY_MANAGER, Kurnool (has a passkey)
let cmOther: AdminSession; // CITY_MANAGER, another city (has a passkey)
let both: AdminSession; // PRICING_ADMIN + CITY_MANAGER, Kurnool (has a passkey)
let prcGlobal: AdminSession;
let cmGlobal: AdminSession;
let support: AdminSession;
let prcLocale: AdminSession; // PRICING_ADMIN, LOCALE_CITY
let cmLocale: AdminSession; // CITY_MANAGER, LOCALE_CITY (has a passkey)

beforeAll(async () => {
  db = await createTestDatabase();
  await loadSyntheticSeed(db.migrator);
  for (const [id, code, locales] of [[OTHER_CITY, 'TSTO', '{en-IN}'], [LOCALE_CITY, 'TSTL', '{en-IN}']] as const) {
    await db.migrator.query(`INSERT INTO geo.cities (id, code, names, state_code, supported_locales, status) VALUES ($1, $2, '{"en":"Test city"}', 'IN-AP', $3, 'PILOT')`,
      [id, code, locales]);
  }
  pool = new pg.Pool({ connectionString: await db.loginFor('app_admin'), max: 5 });
  apiPool = new pg.Pool({ connectionString: await db.loginFor('app_api'), max: 3 });
  const env = { APP_ENV: 'test' };
  const signing = createLocalTokenSigningKey('k-change-test', env);
  const logger = createLogger('hsp-change-test', 'debug', (l) => logs.push(l), () => clock.now());
  app = composeAdminApi({
    pool, clock, logger, idp: idp.config, webauthn: { rpId: RP_ID, origin: ORIGIN }, csrfKey: randomBytes(32), requestHashKey: randomBytes(32),
    allowedOrigins: [ORIGIN], appEnv: 'test', rateLimitStore: new MemoryRateLimitStore(), jobsCodeKey: randomBytes(32),
    identity: { kms: createEphemeralKeyring(env).forRole('admin-api'), keys: { otpPepper: randomBytes(32), blindIndexPepper: randomBytes(32),
      refreshRotationKey: randomBytes(32), csrfKey: randomBytes(32), requestHashKey: randomBytes(32) }, tokenSigner: signing.signer,
      tokenVerificationKeys: signing.publicKeys, issuer: 'https://auth.test.invalid' },
    catalogIssues: () => issuesOverride ?? repositoryCatalogIssues(),
  });
  // The public catalog as the api role reads it (same database, separate process role and pool).
  const policies = new PolicyRegistry();
  registerCatalogPolicies(policies);
  registerGeoPolicies(policies);
  const rateLimiter = createRateLimiter(new MemoryRateLimitStore());
  const geo = new GeoService({ pool: apiPool, clock: readClock, logger, policies, rateLimiter, appEnv: 'test' });
  publicCatalog = new CatalogService({ pool: apiPool, clock: readClock, logger, policies, rateLimiter, cities: geo });

  for (const n of ['fixture-maker', 'fixture-checker', 'prc', 'cm', 'cm-other', 'both', 'prc-global', 'cm-global', 'support', 'prc-locale', 'cm-locale']) await seedAdmin(n);
  const knl = { kind: 'CITIES' as const, cityIds: [CITY.id] };
  await seedGrant('prc', 'PRICING_ADMIN', knl);
  await seedGrant('cm', 'CITY_MANAGER', knl);
  await seedGrant('cm-other', 'CITY_MANAGER', { kind: 'CITIES', cityIds: [OTHER_CITY] });
  await seedGrant('both', 'PRICING_ADMIN', knl);
  await seedGrant('both', 'CITY_MANAGER', knl);
  await seedGrant('prc-global', 'PRICING_ADMIN', { kind: 'GLOBAL' });
  await seedGrant('cm-global', 'CITY_MANAGER', { kind: 'GLOBAL' });
  await seedGrant('support', 'SUPPORT_L2', knl);
  await seedGrant('prc-locale', 'PRICING_ADMIN', { kind: 'CITIES', cityIds: [LOCALE_CITY] });
  await seedGrant('cm-locale', 'CITY_MANAGER', { kind: 'CITIES', cityIds: [LOCALE_CITY] });
  prc = await login('prc');
  cm = await checkerSession('cm');
  cmOther = await checkerSession('cm-other');
  both = await checkerSession('both');
  prcGlobal = await login('prc-global');
  cmGlobal = await checkerSession('cm-global');
  support = await login('support');
  prcLocale = await login('prc-locale');
  cmLocale = await checkerSession('cm-locale');
});

afterAll(async () => {
  await pool?.end();
  await apiPool?.end();
  await db?.close();
});

describe('service rules: two-person approved, shown without a deploy (exit criterion)', () => {
  it('maker proposes, a different city manager approves with a bound step-up, the public catalog changes immediately', async () => {
    expect(await offered()).not.toContain('INVERTER');
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('INVERTER', true));
    expect(await status(id)).toBe('PENDING');
    expect(await offered()).not.toContain('INVERTER'); // nothing changes before approval
    const r = await decide(cm, id, 'APPROVE');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ status: 'EXECUTED' });
    expect(await status(id)).toBe('EXECUTED');
    expect(await offered()).toContain('INVERTER');

    const off = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('INVERTER', false));
    expect((await decide(cm, off, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    expect(await offered()).not.toContain('INVERTER');

    const audit = (await db.migrator.query(
      `SELECT action FROM compliance.audit_logs WHERE resource_id = ANY($1::uuid[]) OR (action = 'catalog.service_rules_changed' AND resource_id = $2) ORDER BY occurred_at, action`,
      [[id, off], serviceTypeId('INVERTER')])).rows.map((x) => x.action as string);
    for (const a of ['approval.requested', 'approval.decided', 'catalog.service_rules_changed', 'approval.executed']) expect(audit).toContain(a);
  });

  it('the earlier rule is cut at the start of the new one (history kept), and a scheduled change applies only from its start', async () => {
    const rows = (await db.migrator.query(
      `SELECT status, upper_inf(effective) AS open FROM catalog.service_rules WHERE service_type_id = $1 AND city_id = $2 ORDER BY lower(effective)`,
      [serviceTypeId('INVERTER'), CITY.id])).rows;
    expect(rows.filter((x) => x.open && x.status === 'ACTIVE')).toHaveLength(1);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const from = new Date(clock.now().getTime() + 2 * 3_600_000).toISOString();
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('MICROWAVE', true, CITY.id, { effectiveFrom: from }));
    expect((await decide(cm, id, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    expect(await offered()).not.toContain('MICROWAVE');
    readClock.advance(2 * 3_600_000 + 1_000);
    expect(await offered()).toContain('MICROWAVE');
  });

  it('a REJECT changes nothing', async () => {
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('TV', true));
    expect((await decide(cm, id, 'REJECT')).body).toEqual({ status: 'REJECTED' });
    expect(await status(id)).toBe('REJECTED');
    expect(await offered()).not.toContain('TV');
  });

  it('an all-city default rule needs GLOBAL grants on both sides', async () => {
    expect((await propose(prc, 'catalog.service_rules.set', ruleChange('MIXER_GRINDER', true, null))).status).toBe(403);
    const id = await proposeOk(prcGlobal, 'catalog.service_rules.set', ruleChange('MIXER_GRINDER', true, null));
    expect((await stepUp(cm, id, 'APPROVE')).status).toBe(403); // city-scoped checker
    expect((await decide(cmGlobal, id, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    expect(await offered(OTHER_CITY)).toEqual(['MIXER_GRINDER']); // no city rule there: the default applies
    expect(await offered()).not.toContain('MIXER_GRINDER'); // Kurnool's own (disabled) rule wins
  });

  it('only the maker permission for the city may propose', async () => {
    expect((await propose(support, 'catalog.service_rules.set', ruleChange('TV', true))).status).toBe(403);
    expect((await propose(cm, 'catalog.service_rules.set', ruleChange('TV', true))).status).toBe(403);
    expect((await propose(prc, 'catalog.service_rules.set', ruleChange('TV', true, OTHER_CITY))).status).toBe(403);
  });

  it('the checker must hold the checker permission for the city and must not be the maker (INV-19)', async () => {
    const id = await proposeOk(both, 'catalog.service_rules.set', ruleChange('TV', true));
    expect((await stepUp(both, id, 'APPROVE')).status).toBe(403);
    expect((await stepUp(cmOther, id, 'APPROVE')).status).toBe(403);
    expect((await stepUp(prc, id, 'APPROVE')).status).toBe(403);
    expect((await req(both, 'POST', `/admin/v1/change-requests/${id}/decision`, { decision: 'APPROVE', stepUpId: newId() })).status).toBe(403);
    expect(await status(id)).toBe('PENDING');
  });

  it('a decision needs a step-up bound to this request and this decision, used once', async () => {
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('TV', true));
    expect((await req(cm, 'POST', `/admin/v1/change-requests/${id}/decision`, { decision: 'APPROVE', stepUpId: newId() })).status).toBe(401);
    const reject = await stepUp(cm, id, 'REJECT');
    expect((await decide(cm, id, 'APPROVE', reject.stepUpId)).status).toBe(401); // bound to REJECT
    const other = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('MICROWAVE', false));
    const forOther = await stepUp(cm, other, 'APPROVE');
    expect((await decide(cm, id, 'APPROVE', forOther.stepUpId)).status).toBe(401); // bound to another request
    expect((await stepUp(cm, id, 'APPROVE', 'security.grant.decide')).status).toBe(404); // a grant step-up can't target it
    expect(await status(id)).toBe('PENDING');
    const ok = await stepUp(cm, id, 'APPROVE');
    expect((await decide(cm, id, 'APPROVE', ok.stepUpId)).status).toBe(200);
    expect((await decide(cm, other, 'APPROVE', ok.stepUpId)).status).toBe(401); // already used
    expect((await decide(cm, id, 'APPROVE', newId())).status).toBe(409); // decided already
  });

  it('a tampered stored payload is never executed', async () => {
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('PLUMBING_TANK_MOTOR', true));
    await db.migrator.query(`UPDATE backoffice.approval_requests SET payload = jsonb_set(payload, '{rules,enabled}', 'false') WHERE id = $1`, [id]);
    expect((await stepUp(cm, id, 'APPROVE')).status).toBe(200);
    expect((await decide(cm, id, 'APPROVE')).status).toBe(409);
    expect(await status(id)).toBe('PENDING');
  });

  it('invalid proposals are refused with field errors', async () => {
    const fields = async (change: Record<string, unknown>) => {
      const r = await propose(prc, 'catalog.service_rules.set', change);
      expect(r.status).toBe(400);
      return ((r.body as { fields?: { path: string; code: string }[] }).fields ?? []).map((f) => `${f.path}:${f.code}`);
    };
    expect(await fields({ ...ruleChange('TV', true), rules: { same_visit_repair_allowed: true } })).toContain('change.rules.enabled:INVALID_TYPE');
    expect((await fields({ ...ruleChange('TV', true), rules: { enabled: true, enabeld: false } })).some((f) => f.startsWith('change.rules'))).toBe(true);
    expect(await fields({ ...ruleChange('TV', true), serviceTypeId: newId() })).toEqual(['change.serviceTypeId:NOT_FOUND']);
    expect(await fields({ ...ruleChange('TV', true), effectiveFrom: new Date(clock.now().getTime() - 60_000).toISOString() })).toEqual(['change.effectiveFrom:OUT_OF_RANGE']);
    expect(await fields({ ...ruleChange('TV', true), unexpected: 1 })).toContain('change.:UNRECOGNIZED_KEYS');
    const unknown = await req(prc, 'POST', '/admin/v1/change-requests', { actionType: 'catalog.prices.set', change: {} }, { 'idempotency-key': randomUUID() });
    expect(unknown.status).toBe(400);
  });

  it('Idempotency-Key: a retry replays the first response; the key with another body is refused', async () => {
    const key = randomUUID();
    const first = await propose(prc, 'catalog.service_rules.set', ruleChange('GEYSER', true), key);
    const again = await propose(prc, 'catalog.service_rules.set', ruleChange('GEYSER', true), key);
    expect(again.status).toBe(202);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect((await propose(prc, 'catalog.service_rules.set', ruleChange('GEYSER', false), key)).status).toBe(422);
    expect((await req(prc, 'POST', '/admin/v1/change-requests', { actionType: 'catalog.service_rules.set', change: ruleChange('GEYSER', true) })).status).toBe(400);
  });

  it('execution is idempotent per change request', async () => {
    const id = await proposeOk(prc, 'catalog.service_rules.set', ruleChange('AC', false));
    expect((await decide(cm, id, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    const payload = (await db.migrator.query('SELECT payload FROM backoffice.approval_requests WHERE id = $1', [id])).rows[0].payload;
    await serviceRulesChangeAction({ pool, cities: { getCity: async () => ({ supportedLocales: ['en-IN'] }) } })
      .execute(id, payload, { now: clock.now(), actorId: admins['cm'] ?? '', requestId: randomUUID() });
    expect((await db.migrator.query('SELECT count(*)::int AS n FROM catalog.service_rules WHERE approval_request_id = $1', [id])).rows[0].n).toBe(1);
    expect((await req(cm, 'POST', `/admin/v1/change-requests/${id}/execute`)).body).toEqual({ status: 'EXECUTED' });
    expect((await req(prc, 'POST', `/admin/v1/change-requests/${id}/execute`)).status).toBe(403);
  });
});

describe('city languages: enablement gate (exit criterion: a missing translation blocks enablement)', () => {
  const locales = async (cityId: string) => (await db.migrator.query('SELECT supported_locales FROM geo.cities WHERE id = $1', [cityId])).rows[0].supported_locales as string[];
  const localeChange = (supportedLocales: string[], cityId = LOCALE_CITY) => ({ cityId, supportedLocales });

  it('a missing translation blocks the proposal', async () => {
    issuesOverride = [{ locale: 'te-IN', key: 'geo.serviceable', code: 'MISSING' }];
    const r = await propose(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN']));
    expect(r.status).toBe(400);
    expect((r.body as { fields: { path: string; code: string }[] }).fields).toEqual([{ path: 'change.supportedLocales.te-IN', code: 'UI_CATALOG' }]);
    issuesOverride = undefined;
  });

  it('with complete repository catalogs, a two-person approved change enables the locale', async () => {
    const id = await proposeOk(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN']));
    expect((await decide(cmLocale, id, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    expect(await locales(LOCALE_CITY)).toEqual(['en-IN', 'te-IN']);
  });

  it('the gate is re-checked at execution: a translation that breaks after the proposal blocks it (fail closed)', async () => {
    const id = await proposeOk(prcLocale, 'geo.city.locales.set', localeChange(['te-IN']));
    expect((await decide(cmLocale, id, 'APPROVE')).body).toEqual({ status: 'EXECUTED' }); // removing en-IN adds nothing
    const add = await proposeOk(prcLocale, 'geo.city.locales.set', localeChange(['te-IN', 'en-IN']));
    issuesOverride = [{ locale: 'en-IN', key: null, code: 'FILE_INVALID' }];
    expect((await decide(cmLocale, add, 'APPROVE')).body).toEqual({ status: 'APPROVED' });
    expect(await locales(LOCALE_CITY)).toEqual(['te-IN']);
    expect((await req(cmLocale, 'POST', `/admin/v1/change-requests/${add}/execute`)).status).toBe(409);
    issuesOverride = undefined;
    expect((await req(cmLocale, 'POST', `/admin/v1/change-requests/${add}/execute`)).body).toEqual({ status: 'EXECUTED' });
    expect(await locales(LOCALE_CITY)).toEqual(['te-IN', 'en-IN']);
  });

  it('a stale approval (the city changed since the proposal) does not execute', async () => {
    const a = await proposeOk(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN']));
    const b = await proposeOk(prcLocale, 'geo.city.locales.set', localeChange(['en-IN']));
    expect((await decide(cmLocale, b, 'APPROVE')).body).toEqual({ status: 'EXECUTED' });
    expect((await decide(cmLocale, a, 'APPROVE')).body).toEqual({ status: 'APPROVED' });
    expect(await locales(LOCALE_CITY)).toEqual(['en-IN']);
  });

  it('unregistered locales, duplicates, no-ops and the wrong roles or city are refused', async () => {
    expect((await propose(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'hi-IN']))).status).toBe(400);
    expect((await propose(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'en-IN']))).status).toBe(400);
    expect((await propose(prcLocale, 'geo.city.locales.set', localeChange(['en-IN']))).status).toBe(400);
    expect((await propose(prcLocale, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN'], CITY.id))).status).toBe(403);
    expect((await propose(cmLocale, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN']))).status).toBe(403);
    expect((await propose(prc, 'geo.city.locales.set', localeChange(['en-IN', 'te-IN']))).status).toBe(403);
  });

  it('outside local / test the gate fails closed until IVR, template and native-review evidence exist (not built in Gate 4)', async () => {
    const action = cityLocalesChangeAction({ pool, appEnv: 'staging' });
    await expect(action.prepare(localeChange(['en-IN', 'te-IN']))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: ['IVR_PROMPTS', 'NOTIFICATION_TEMPLATES', 'NATIVE_SPEAKER_REVIEW'].map((code) => ({ path: 'change.supportedLocales.te-IN', code })),
    });
  });
});

describe('authorization: matrix row "Edit pricing/rules" for service rules (PRC M, CM C)', () => {
  it('maker / checker capability per matrix column, from the seeded role permissions', async () => {
    const row = AUTHZ_MATRIX.find((r) => r.capability === 'Edit pricing/rules');
    const ROLE_FOR: Partial<Record<MatrixColumn, string>> = {
      'SUP-L1': 'SUPPORT_L1', 'SUP-L2': 'SUPPORT_L2', DISP: 'DISPATCH', VER: 'VERIFICATION_OFFICER', SAF: 'SAFETY_OFFICER', FIN: 'FINANCE',
      CM: 'CITY_MANAGER', PRC: 'PRICING_ADMIN', AUD: 'AUDITOR', SEC: 'SECURITY_ADMIN',
    };
    for (const column of MATRIX_COLUMNS) {
      if (column === 'SUPER (BG)') continue; // break-glass (05 §9) is not a Gate 4 deliverable
      const role = ROLE_FOR[column];
      const perms = role ? (await db.migrator.query('SELECT permission FROM backoffice.role_permissions WHERE role_code = $1', [role])).rows.map((r) => r.permission as string) : [];
      const actor: Actor = role
        ? { kind: 'ADMIN', id: `a-${column}`, sessionId: 's', permissions: new Map(perms.map((p) => [p, [{ kind: 'CITIES' as const, cityIds: [CITY.id] }]])) }
        : { kind: column === 'CUS' ? 'CUSTOMER' : column === 'AGT' ? 'FIELD_AGENT' : 'TECHNICIAN', id: `u-${column}` };
      const cell = row?.cells[column] ?? '';
      const ctx = { now: clock.now() };
      expect(app.policies.can(actor, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: CITY.id, requesterId: actor.id ?? null }, ctx).allow, `${column} M`)
        .toBe(cell.includes('M'));
      expect(app.policies.can(actor, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: CITY.id, requesterId: 'someone-else' }, ctx).allow, `${column} C`)
        .toBe(cell.includes('C'));
    }
  });

  it('every seeded role permission (migrations 0027, 0029, 0030) is defined in code', async () => {
    const rows = (await db.migrator.query('SELECT DISTINCT permission FROM backoffice.role_permissions')).rows.map((r) => r.permission as string);
    for (const p of rows) expect(isKnownPermissionEntry(p), p).toBe(true);
  });

  it('the language permissions are held only by the roles ADR-025 #6 proposes', async () => {
    const rows = (await db.migrator.query("SELECT role_code, permission FROM backoffice.role_permissions WHERE permission LIKE 'locales.%' ORDER BY permission")).rows;
    expect(rows).toEqual([{ role_code: 'CITY_MANAGER', permission: 'locales.approve' }, { role_code: 'PRICING_ADMIN', permission: 'locales.enable' }]);
  });
});

describe('step-up binding for change decisions (migration 0030 CHECK)', () => {
  it('a change-decision challenge without its binding is refused by the database', async () => {
    const session = (await db.admin.query('SELECT id FROM backoffice.admin_sessions WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1', [admins['cm']])).rows[0].id;
    const insert = (action: string, resourceId: string | null, hash: Buffer | null, decision: string | null) => db.migrator.query(
      `INSERT INTO backoffice.webauthn_challenges (id, admin_user_id, session_id, purpose, challenge_hash, action, resource_id, payload_hash, decision, expires_at)
       VALUES ($1, $2, $3, 'STEP_UP', $4, $5, $6, $7, $8, now() + interval '5 minutes')`, [newId(), admins['cm'], session, randomBytes(32), action, resourceId, hash, decision]);
    await insert('backoffice.change.decide', newId(), randomBytes(32), 'REJECT'); // complete binding: accepted
    for (const [label, args] of [
      ['no decision', ['backoffice.change.decide', newId(), randomBytes(32), null]],
      ['no hash', ['backoffice.change.decide', newId(), null, 'APPROVE']],
      ['no request', ['backoffice.change.decide', null, randomBytes(32), 'APPROVE']],
      ['bad decision', ['backoffice.change.decide', newId(), randomBytes(32), 'MAYBE']],
      ['unknown operation', ['catalog.anything', null, null, null]],
    ] as const) {
      await expect(insert(...(args as unknown as [string, string | null, Buffer | null, string | null])), label).rejects.toMatchObject({ code: '23514' });
    }
  });
});
