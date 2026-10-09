// Gate 5 exit criteria through the api composition (Phase 1 04 §7 / §10, 06 §2–§4 / §10, 02 §5): booking idempotency and
// the soft duplicate check, adult-present required, manual assignment with INV-01 / INV-03, start-code protection and
// INV-14, time-travel disclosure tests including an unverified customer (INV-17, G-4, X-30), cancellation evaluation
// with a policy snapshot and the TCP-3 bill seam, release, and the timers / sweeper. Throwaway database, synthetic
// customers, technicians and addresses (kms-local), fake SMS.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { arrivalOverrideChangeAction } from '@hsp/module-jobs';
import { subjectKeyStore } from '@hsp/module-identity';
import { AUTHZ_MATRIX, cellAllows, MATRIX_COLUMNS, type Actor, type MatrixColumn } from '@hsp/policy';
import { blindIndex, createFieldCrypto } from '@hsp/security';
import { kurnool, loadSyntheticSeed } from '@hsp/testing';
import { createApiHarness, meta, ORIGIN, testPhone, type ApiHarness } from './harness.ts';

let h: ApiHarness;
let apiPool: pg.Pool;
const { CITY, serviceTypeId, localityByCode } = kurnool;
const VISIT_FEE = 19900; // MODEL_B fixture (NOT FINAL)
const HOUR = 3_600_000;

beforeAll(async () => {
  h = await createApiHarness();
  await loadSyntheticSeed(h.db.migrator);
  apiPool = new pg.Pool({ connectionString: await h.db.loginFor('app_api'), max: 3 });
});
afterAll(async () => {
  await apiPool?.end();
  await h?.close();
});

// ---------------------------------------------------------------- helpers

const identity = (method: string, path: string, body?: unknown) => h.api.http({ method, path, headers: {}, body, meta: meta() });

async function otp(phone: string) {
  const r = await identity('POST', '/v1/auth/otp/request', { phone, purpose: 'LOGIN', locale: 'te-IN' });
  const challengeId = (r.body as { challengeId: string }).challengeId;
  return { challengeId, code: h.sms.codeFor(challengeId) ?? '' };
}

const userIdOf = async (phone: string) =>
  (await h.db.admin.query('SELECT id FROM identity.users WHERE phone_bidx = $1', [blindIndex(h.keys.blindIndexPepper, phone)])).rows[0]?.id as string;

interface Customer { cookie: string; csrf: string; userId: string }

async function customer(): Promise<Customer> {
  const phone = testPhone();
  const o = await otp(phone);
  const r = await identity('POST', '/v1/auth/otp/verify', { challengeId: o.challengeId, code: o.code, surface: 'CUSTOMER_WEB', device: { platform: 'WEB' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: (r.headers['set-cookie'] ?? '').split(';')[0] ?? '', csrf: (r.body as { csrfToken: string }).csrfToken, userId: await userIdOf(phone) };
}

interface Technician { token: string; userId: string; phone: string; issuedAt: number }

async function technician(capacity = 1): Promise<Technician> {
  const phone = testPhone();
  await otp(phone);
  const userId = await userIdOf(phone);
  h.technicians.add(userId);
  await h.db.migrator.query(`INSERT INTO workforce.technician_profiles (user_id, legal_name_enc, display_name, device_mode, city_id, home_locality_id,
      languages, birth_year, onboarding_status, status, capacity, ivr_locale)
    VALUES ($1, $2, 'Test Technician', 'SMARTPHONE', $3, $4, '{te}', 1990, 'READY', 'ACTIVE', $5, 'te-IN')`,
  [userId, randomBytes(24), CITY.id, localityByCode('LOC-02').id, capacity]);
  return appSession(phone, userId);
}

/** App login (access tokens live 10 minutes, so time-travel tests sign in again when the clock has moved on). */
async function appSession(phone: string, userId: string): Promise<Technician> {
  h.clock.advance(31_000); // OTP resend cooldown
  const o = await otp(phone);
  const r = await identity('POST', '/v1/auth/otp/verify', { challengeId: o.challengeId, code: o.code, surface: 'TECHNICIAN_APP',
    device: { platform: 'ANDROID_APP', appVersion: '1.0.0' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { token: (r.body as { accessToken: string }).accessToken, userId, phone, issuedAt: h.clock.now().getTime() };
}

/** A synthetic address sealed with kms-local under the customer's pii-address key (the seed's fixture crypto can't be opened). */
async function address(customerUserId: string, locality = 'LOC-02', text = 'Flat 7, Synthetic Residency'): Promise<string> {
  const crypto = createFieldCrypto({ kms: h.keyring.forRole('api'), store: subjectKeyStore(apiPool), clock: h.clock });
  const ctx = { subjectId: customerUserId, dataClass: 'pii-address' as const };
  const id = newId();
  await h.db.migrator.query(`INSERT INTO customers.addresses (id, customer_user_id, city_id, locality_id, line1_enc, landmark_enc, access_notes_enc)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, customerUserId, CITY.id, localityByCode(locality).id, await crypto.seal(ctx, text),
    await crypto.seal(ctx, 'Opposite the test park'), await crypto.seal(ctx, 'Ring the second bell')]);
  return id;
}

function slot(hoursAhead: number) {
  const step = 30 * 60_000;
  const start = new Date(Math.ceil((h.clock.now().getTime() + hoursAhead * HOUR) / step) * step);
  return { type: 'SLOT' as const, start: start.toISOString(), end: new Date(start.getTime() + 2 * HOUR).toISOString() };
}

const bookingBody = (addressId: string, over: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(), serviceTypeId: serviceTypeId('REFRIGERATOR'), symptomCodes: [kurnool.SYMPTOMS.find((s) => s.serviceType === 'REFRIGERATOR')?.code],
  addressId, timing: { type: 'ASAP' }, acceptedVisitFeePaise: VISIT_FEE, paymentPreference: 'EITHER', onsiteAdult: 'SELF', ...over,
});

const asCustomer = (c: Customer, method: string, path: string, body?: unknown, key: string | null = randomUUID()) => h.api.jobsHttp({
  method, path, body, meta: meta(),
  headers: { cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': c.csrf, ...(key ? { 'idempotency-key': key } : {}) },
});

async function asTech(t: Technician, method: string, path: string, body?: unknown, key: string | null = randomUUID()) {
  if (h.clock.now().getTime() - t.issuedAt > 8 * 60_000) Object.assign(t, await appSession(t.phone, t.userId));
  return h.api.jobsHttp({ method, path, body, meta: meta(), headers: { authorization: `Bearer ${t.token}`, ...(key ? { 'idempotency-key': key } : {}) } });
}

async function book(c: Customer, body: Record<string, unknown>): Promise<{ jobId: string; visitId: string }> {
  const r = await asCustomer(c, 'POST', '/v1/customer/jobs', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const b = r.body as { jobId: string; visits: { visitId: string }[] };
  return { jobId: b.jobId, visitId: b.visits[0]?.visitId ?? '' };
}

const ops: Actor = { kind: 'ADMIN', id: newId(), sessionId: newId(), surface: 'ADMIN',
  permissions: new Map([['dispatch.assign', [{ kind: 'CITIES', cityIds: [CITY.id] }]], ['support.book', [{ kind: 'CITIES', cityIds: [CITY.id] }]]]) };
const assign = (visitId: string, t: Technician) => h.api.jobs.assignManually(ops, visitId, { technicianUserId: t.userId, reasonCode: 'TEST_ASSIGN' }, randomUUID(), meta());
const row = async (sql: string, params: unknown[]) => (await h.db.migrator.query(sql, params)).rows[0] as Record<string, unknown>;
const visitStatus = async (id: string) => (await row('SELECT status FROM jobs.visits WHERE id = $1', [id]))['status'];
const jobStatus = async (id: string) => (await row('SELECT status, needs_attention FROM jobs.jobs WHERE id = $1', [id]));

async function startCode(c: Customer, visitId: string): Promise<string> {
  const r = await asCustomer(c, 'POST', `/v1/customer/visits/${visitId}/start-code`, {}, null);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { startCode: string }).startCode;
}

// ---------------------------------------------------------------- booking

describe('booking (04 §7, 06 §13)', () => {
  it('creates a REQUESTED job and a PLANNED diagnosis visit with history, outbox, audit and a match-start timer', async () => {
    const c = await customer();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    expect(await jobStatus(jobId)).toMatchObject({ status: 'REQUESTED' });
    expect(await visitStatus(visitId)).toBe('PLANNED');
    expect(await row("SELECT actor_type, channel FROM jobs.job_status_history WHERE job_id = $1", [jobId])).toEqual({ actor_type: 'CUSTOMER', channel: 'PWA' });
    expect(await row("SELECT count(*)::int AS n FROM platform.outbox WHERE aggregate_id = $1 AND event_type = 'JobRequested'", [jobId])).toEqual({ n: 1 });
    expect(await row("SELECT count(*)::int AS n FROM compliance.audit_logs WHERE resource_id = $1 AND action = 'job.created'", [jobId])).toEqual({ n: 1 });
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`visit:${visitId}:matchStart`])).toEqual({ n: 1 });
    const snapshot = await row('SELECT p.outputs FROM jobs.jobs j JOIN pricing.price_snapshots p ON p.id = j.visit_fee_snapshot_id WHERE j.id = $1', [jobId]);
    expect(snapshot['outputs']).toEqual({ visitFeePaise: VISIT_FEE });
  });

  it('adult present is required (X-34)', async () => {
    const c = await customer();
    const a = await address(c.userId);
    const without: Record<string, unknown> = { ...bookingBody(a) };
    delete without['onsiteAdult'];
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', without)).status).toBe(400);
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a, { onsiteAdult: 'NOBODY' }))).status).toBe(400);
  });

  it('duplicate bookings: key replay, same client request, soft duplicate (409 unless confirmed), concurrent double submit', async () => {
    const c = await customer();
    const a = await address(c.userId);
    const body = bookingBody(a);
    const key = randomUUID();
    const first = await asCustomer(c, 'POST', '/v1/customer/jobs', body, key);
    const replay = await asCustomer(c, 'POST', '/v1/customer/jobs', body, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const sameRequest = await asCustomer(c, 'POST', '/v1/customer/jobs', body); // new key, same clientRequestId
    expect(sameRequest.status).toBe(200);
    expect((sameRequest.body as { jobId: string }).jobId).toBe((first.body as { jobId: string }).jobId);
    const dup = await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'POSSIBLE_DUPLICATE', details: { existingJobId: (first.body as { jobId: string }).jobId } });
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a, { confirmSeparate: true }))).status).toBe(201);
    const concurrent = bookingBody(a, { serviceTypeId: serviceTypeId('PLUMBING_GENERAL'), symptomCodes: [kurnool.SYMPTOMS.find((s) => s.serviceType === 'PLUMBING_GENERAL')?.code] });
    const both = await Promise.all([asCustomer(c, 'POST', '/v1/customer/jobs', concurrent), asCustomer(c, 'POST', '/v1/customer/jobs', concurrent)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await row('SELECT count(*)::int AS n FROM jobs.jobs WHERE customer_user_id = $1 AND client_request_id = $2', [c.userId, concurrent.clientRequestId]))
      .toEqual({ n: 1 });
  });

  it('refuses a changed price, an unserved address, a service not offered, a foreign address, an off-grid slot', async () => {
    const c = await customer();
    const other = await customer();
    const a = await address(c.userId);
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a, { acceptedVisitFeePaise: 100 }))).body).toMatchObject({ code: 'PRICE_CHANGED', details: { visitFeePaise: VISIT_FEE } });
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a, { serviceTypeId: serviceTypeId('INVERTER') }))).status).toBe(400);
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(await address(other.userId)))).status).toBe(404);
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(a, { timing: { type: 'SLOT', start: new Date(h.clock.now().getTime() + 6 * HOUR + 7 * 60_000).toISOString(),
      end: new Date(h.clock.now().getTime() + 8 * HOUR + 7 * 60_000).toISOString() } }))).body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    await h.db.migrator.query("UPDATE geo.localities SET status = 'INACTIVE' WHERE id = $1", [localityByCode('LOC-11').id]);
    expect((await asCustomer(c, 'POST', '/v1/customer/jobs', bookingBody(await address(c.userId, 'LOC-11')))).body).toMatchObject({ code: 'NOT_SERVICEABLE' });
    await h.db.migrator.query("UPDATE geo.localities SET status = 'ACTIVE' WHERE id = $1", [localityByCode('LOC-11').id]);
  });

  it('a customer sees only their own job (404 for another)', async () => {
    const c = await customer();
    const other = await customer();
    const { jobId } = await book(c, bookingBody(await address(c.userId)));
    expect((await asCustomer(c, 'GET', `/v1/customer/jobs/${jobId}`, undefined, null)).status).toBe(200);
    expect((await asCustomer(other, 'GET', `/v1/customer/jobs/${jobId}`, undefined, null)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- assignment

describe('manual assignment (06 §4, INV-01, INV-03)', () => {
  it('assigns a MATCHING or PLANNED visit, moves the job to IN_DIAGNOSIS and replaces the matching timers with a no-show timer', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    expect(await visitStatus(visitId)).toBe('ASSIGNED');
    expect(await jobStatus(jobId)).toMatchObject({ status: 'IN_DIAGNOSIS' });
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`visit:${visitId}:matchStart`])).toEqual({ n: 0 });
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`visit:${visitId}:techNoShow`])).toEqual({ n: 1 });
    // INV-01: a second assignment is refused (the visit is no longer matchable).
    await expect(assign(visitId, await technician())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('INV-03: a technician at capacity can not take an overlapping visit; a non-overlapping one is fine', async () => {
    const c = await customer();
    const t = await technician(1);
    const a = await address(c.userId);
    const w1 = slot(6);
    const first = await book(c, bookingBody(a, { timing: w1 }));
    const overlapping = await book(c, bookingBody(a, { timing: w1, confirmSeparate: true }));
    const later = await book(c, bookingBody(a, { timing: slot(30), confirmSeparate: true }));
    await assign(first.visitId, t);
    await expect(assign(overlapping.visitId, t)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'technicianUserId', code: 'AT_CAPACITY' }] });
    await assign(later.visitId, t);
  });

  it('needs dispatch.assign for the city, an ACTIVE technician of that city', async () => {
    const c = await customer();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    const otherCity: Actor = { ...ops, permissions: new Map([['dispatch.assign', [{ kind: 'CITIES', cityIds: [newId()] }]]]) };
    await expect(h.api.jobs.assignManually(otherCity, visitId, { technicianUserId: newId(), reasonCode: 'TEST' }, randomUUID(), meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.api.jobs.assignManually(ops, visitId, { technicianUserId: newId(), reasonCode: 'TEST' }, randomUUID(), meta()))
      .rejects.toMatchObject({ fields: [{ path: 'technicianUserId', code: 'NOT_ASSIGNABLE' }] });
  });
});

describe('authorization matrix row "Manual assignment" (05 §11: DISP S, CM S) against the seeded roles (ADR-026 #13)', () => {
  const ROLE_FOR: Partial<Record<MatrixColumn, string>> = {
    'SUP-L1': 'SUPPORT_L1', 'SUP-L2': 'SUPPORT_L2', DISP: 'DISPATCH', VER: 'VERIFICATION_OFFICER', SAF: 'SAFETY_OFFICER', FIN: 'FINANCE',
    CM: 'CITY_MANAGER', PRC: 'PRICING_ADMIN', AUD: 'AUDITOR', SEC: 'SECURITY_ADMIN',
  };
  const actorFor = async (column: MatrixColumn, cityIds: string[]): Promise<Actor> => {
    const role = ROLE_FOR[column];
    if (!role) return { kind: column === 'CUS' ? 'CUSTOMER' : column === 'AGT' ? 'FIELD_AGENT' : 'TECHNICIAN', id: newId(), sessionId: newId() };
    const perms = (await h.db.migrator.query('SELECT permission FROM backoffice.role_permissions WHERE role_code = $1', [role])).rows.map((r) => r.permission as string);
    return { kind: 'ADMIN', id: newId(), sessionId: newId(), surface: 'ADMIN', permissions: new Map(perms.map((p) => [p, [{ kind: 'CITIES' as const, cityIds }]])) };
  };

  it('every column: allowed in its own city exactly when the cell allows; never in another city', async () => {
    const row = AUTHZ_MATRIX.find((r) => r.capability === 'Manual assignment');
    for (const column of MATRIX_COLUMNS) {
      if (column === 'SUPER (BG)') continue; // break-glass (05 §9) is not built
      const actor = await actorFor(column, [CITY.id]);
      const can = (cityId: string) => h.api.policies.can(actor, 'jobs.visit.assign_manual', { cityId }, { now: h.clock.now() }).allow;
      expect(can(CITY.id), `${column} in its city`).toBe(cellAllows(row?.cells[column] ?? '❌'));
      expect(can(newId()), `${column} in another city`).toBe(false);
    }
  });

  it('a city manager built from the seeded role assigns a visit end to end', async () => {
    const c = await customer();
    const t = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    const cm = await actorFor('CM', [CITY.id]);
    await expect(h.api.jobs.assignManually(cm, visitId, { technicianUserId: t.userId, reasonCode: 'ESCALATION_ASSIGN' }, randomUUID(), meta()))
      .resolves.toMatchObject({ visitStatus: 'ASSIGNED' });
  });
});

// ---------------------------------------------------------------- technician actions and codes

describe('technician actions and the start code (INV-14)', () => {
  it('depart is idempotent; a wrong code is counted; the right code makes the visit ON_SITE → IN_PROGRESS with a START_CODE proof', async () => {
    const c = await customer();
    const t = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    const code = await startCode(c, visitId);
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() })).body).toEqual({ visitStatus: 'EN_ROUTE' });
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() })).body).toEqual({ visitStatus: 'EN_ROUTE' });
    const wrong = code === '0000' ? '1111' : '0000';
    const bad = await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: wrong, clientReportedAt: h.clock.now().toISOString() });
    expect(bad.body).toMatchObject({ code: 'CODE_INCORRECT', details: { attemptsLeft: 4 } });
    const ok = await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: code, clientReportedAt: h.clock.now().toISOString() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await visitStatus(visitId)).toBe('IN_PROGRESS');
    expect(await row("SELECT count(*)::int AS n FROM jobs.visit_presence_proofs WHERE visit_id = $1 AND kind = 'START_CODE'", [visitId])).toEqual({ n: 1 });
  });

  it('a code entered without "depart" inserts an implicit departure (E0, X-35)', async () => {
    const c = await customer();
    const t = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    const code = await startCode(c, visitId);
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: code, clientReportedAt: h.clock.now().toISOString() })).status).toBe(200);
    expect(await row("SELECT reason_code FROM jobs.visit_status_history WHERE visit_id = $1 AND to_status = 'EN_ROUTE'", [visitId])).toEqual({ reason_code: 'IMPLICIT_DEPARTURE' });
  });

  it('five wrong codes lock the code (423), alert ops, and a re-issued code stays locked', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    const code = await startCode(c, visitId);
    const wrong = code === '0000' ? '1111' : '0000';
    for (let i = 0; i < 4; i += 1) {
      expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: wrong, clientReportedAt: h.clock.now().toISOString() })).status).toBe(400);
    }
    const locked = await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: wrong, clientReportedAt: h.clock.now().toISOString() });
    expect(locked.status).toBe(423);
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: code, clientReportedAt: h.clock.now().toISOString() })).status).toBe(423);
    expect(await jobStatus(jobId)).toMatchObject({ needs_attention: true });
    expect((await asCustomer(c, 'POST', `/v1/customer/visits/${visitId}/start-code`, {}, null)).body).toMatchObject({ code: 'CODE_LOCKED' });
    expect(await visitStatus(visitId)).toBe('ASSIGNED');
  });

  it('another technician can neither read nor act on the visit (404)', async () => {
    const c = await customer();
    const t = await technician();
    const stranger = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    expect((await asTech(stranger, 'GET', `/v1/technician/visits/${visitId}`, undefined, null)).status).toBe(404);
    expect((await asTech(stranger, 'POST', `/v1/technician/visits/${visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() })).status).toBe(404);
  });

  it('an approved ops arrival override is the audited alternative to the code (INV-14)', async () => {
    const c = await customer();
    const t = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    const action = arrivalOverrideChangeAction(h.api.jobs);
    const prepared = await action.prepare({ visitId, reasonCode: 'CUSTOMER_CONFIRMED_ARRIVAL', customerConfirmedByCall: true });
    expect(prepared.cityId).toBe(CITY.id);
    await expect(action.prepare({ visitId, reasonCode: 'CUSTOMER_CONFIRMED_ARRIVAL' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const changeRequestId = newId();
    await action.execute(changeRequestId, prepared.payload, { now: h.clock.now(), actorId: ops.id ?? '', requestId: randomUUID() });
    await action.execute(changeRequestId, prepared.payload, { now: h.clock.now(), actorId: ops.id ?? '', requestId: randomUUID() }); // idempotent
    expect(await visitStatus(visitId)).toBe('IN_PROGRESS');
    expect(await row("SELECT count(*)::int AS n FROM jobs.visit_presence_proofs WHERE visit_id = $1 AND kind = 'OPS_OVERRIDE_ARRIVAL' AND approval_request_id = $2",
      [visitId, changeRequestId])).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------- disclosure (time travel)

describe('disclosure (INV-17, G-4, X-30): time-travel tests', () => {
  const view = async (t: Technician, visitId: string) => {
    const r = await asTech(t, 'GET', `/v1/technician/visits/${visitId}`, undefined, null);
    return { status: r.status, body: r.body as { disclosureLevel?: string; location?: { addressText: string } } };
  };
  const disclosures = async (visitId: string) => (await row('SELECT count(*)::int AS n FROM compliance.disclosure_events WHERE visit_id = $1', [visitId]))['n'];

  it('verified customer: L1 before the window opens, L2 (logged) from window start − 3 h, L3 after the visit closes + 60 min', async () => {
    const c = await customer();
    const t = await technician();
    const { visitId } = await book(c, bookingBody(await address(c.userId, 'LOC-02', 'Flat 9, Time Travel Towers'), { timing: slot(8) }));
    await assign(visitId, t);
    const before = await view(t, visitId);
    expect(before.body.disclosureLevel).toBe('L1');
    expect(before.body.location).toBeUndefined();
    h.clock.advance(6 * HOUR); // now inside window start − 3 h
    const inside = await view(t, visitId);
    expect(inside.body.disclosureLevel).toBe('L2');
    expect(inside.body.location?.addressText).toBe('Flat 9, Time Travel Towers');
    expect(await disclosures(visitId)).toBe(1);
    // Customer no-show ends the visit; L2 stays for 60 minutes, then L3 without the address.
    await asTech(t, 'POST', `/v1/technician/visits/${visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() });
    const loc = localityByCode('LOC-02');
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/wait/start`, { location: { lat: loc.lat, lng: loc.lon, accuracyM: 15 } })).status).toBe(200);
    h.clock.advance(21 * 60_000);
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('CUSTOMER_NO_SHOW');
    expect((await view(t, visitId)).body.disclosureLevel).toBe('L2');
    h.clock.advance(61 * 60_000);
    const after = await view(t, visitId);
    expect(after.body.disclosureLevel).toBe('L3');
    expect(after.body.location).toBeUndefined();
    h.clock.advance(31 * 24 * HOUR);
    expect((await view(t, visitId)).status).toBe(404);
  });

  it('unverified (ops-assisted) customer: L1 even inside the window until ops confirms by call (G-4)', async () => {
    const c = await customer();
    const t = await technician();
    const body = { ...bookingBody(await address(c.userId), { timing: slot(5) }), customerUserId: c.userId };
    const booked = await h.api.jobs.bookAssisted(ops, body as never, randomUUID(), meta());
    const visitId = (booked.body as { visits: { visitId: string }[] }).visits[0]?.visitId ?? '';
    expect((booked.body as { customerVerified: boolean }).customerVerified).toBe(false);
    await assign(visitId, t);
    h.clock.advance(3 * HOUR);
    const unverified = await view(t, visitId);
    expect(unverified.body.disclosureLevel).toBe('L1');
    expect(await disclosures(visitId)).toBe(0);
    await h.api.jobs.confirmCustomerByCall(ops, (booked.body as { jobId: string }).jobId, { reasonCode: 'REGISTERED_NUMBER_CALL' }, meta());
    expect((await view(t, visitId)).body.disclosureLevel).toBe('L2');
  });

  it('a released technician drops to L3 at once', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    expect((await view(t, visitId)).body.disclosureLevel).toBe('L2'); // ASAP: the window is open
    const r = await asTech(t, 'POST', `/v1/technician/visits/${visitId}/release`, { reasonCode: 'VEHICLE_BREAKDOWN' });
    expect(r.body).toMatchObject({ visitStatus: 'MATCHING' });
    expect(await jobStatus(jobId)).toMatchObject({ status: 'REQUESTED' });
    expect((await view(t, visitId)).body.disclosureLevel).toBe('L3');
  });
});

// ---------------------------------------------------------------- cancellation (06 §10)

describe('cancellation evaluation with a policy snapshot, TCP-3 bill seam', () => {
  async function cancel(c: Customer, jobId: string) {
    const preview = await asCustomer(c, 'GET', `/v1/customer/jobs/${jobId}/cancellation-preview`, undefined, null);
    const fee = (preview.body as { feePaise: number }).feePaise;
    const r = await asCustomer(c, 'POST', `/v1/customer/jobs/${jobId}/cancel`, { reasonCode: 'CHANGED_MIND', acceptedFeePaise: fee });
    return { preview: preview.body as { stage: string; feePaise: number }, result: r };
  }

  it('free before assignment and before the free-cancel lead; a late fee; an en-route fee with a bill', async () => {
    const c = await customer();
    const t = await technician(5);
    const a = await address(c.userId);
    const before = await book(c, bookingBody(a));
    expect((await cancel(c, before.jobId)).preview).toMatchObject({ stage: 'BEFORE_ASSIGNMENT', feePaise: 0 });
    expect(await jobStatus(before.jobId)).toMatchObject({ status: 'CANCELLED' });

    const free = await book(c, bookingBody(a, { timing: slot(10), clientRequestId: randomUUID() }));
    await assign(free.visitId, t);
    expect((await cancel(c, free.jobId)).preview).toMatchObject({ stage: 'ASSIGNED_FREE', feePaise: 0 });

    const late = await book(c, bookingBody(a, { clientRequestId: randomUUID() }));
    await assign(late.visitId, t);
    const lateResult = await cancel(c, late.jobId);
    expect(lateResult.preview).toMatchObject({ stage: 'ASSIGNED_LATE', feePaise: 4900 });
    expect(lateResult.result.body).toMatchObject({ status: 'CANCELLED', feePaise: 4900, billId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const record = await row(`SELECT c.customer_fee_paise, c.technician_compensation_paise, p.outputs FROM jobs.job_cancellations c
      JOIN pricing.price_snapshots p ON p.id = c.price_snapshot_id WHERE c.job_id = $1`, [late.jobId]);
    expect(record).toMatchObject({ customer_fee_paise: '4900', technician_compensation_paise: '3675' });
    expect(await row("SELECT status FROM jobs.assignments WHERE visit_id = $1", [late.visitId])).toEqual({ status: 'RELEASED' });

    const enRoute = await book(c, bookingBody(a, { clientRequestId: randomUUID() }));
    await assign(enRoute.visitId, t);
    await asTech(t, 'POST', `/v1/technician/visits/${enRoute.visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() });
    expect((await cancel(c, enRoute.jobId)).preview).toMatchObject({ stage: 'EN_ROUTE', feePaise: 9900 });
  });

  it('the accepted fee must equal the evaluated one; once on site the customer can not cancel', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    expect((await asCustomer(c, 'POST', `/v1/customer/jobs/${jobId}/cancel`, { reasonCode: 'CHANGED_MIND', acceptedFeePaise: 0 })).body)
      .toMatchObject({ code: 'PRICE_CHANGED', details: { feePaise: 4900 } });
    const code = await startCode(c, visitId);
    await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: code, clientReportedAt: h.clock.now().toISOString() });
    expect((await asCustomer(c, 'GET', `/v1/customer/jobs/${jobId}/cancellation-preview`, undefined, null)).status).toBe(409);
  });
});

// ---------------------------------------------------------------- timers via the sweeper

describe('timers and the sweeper (06 §3)', () => {
  it('ASAP visits start matching; MATCHING past the SLA becomes UNFULFILLED and flags the job', async () => {
    const c = await customer();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('MATCHING');
    h.clock.advance(31 * 60_000);
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('UNFULFILLED');
    expect(await jobStatus(jobId)).toMatchObject({ needs_attention: true });
  });

  it('technician no-show: the assignment becomes NO_SHOW, the visit is re-matched, the job flagged', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    h.clock.advance(31 * 60_000);
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('MATCHING');
    expect(await row('SELECT status FROM jobs.assignments WHERE visit_id = $1', [visitId])).toEqual({ status: 'NO_SHOW' });
    expect(await jobStatus(jobId)).toMatchObject({ status: 'REQUESTED', needs_attention: true });
  });

  it('customer no-show after the wait grace: no-show fee billed through TCP-3, job awaiting payment', async () => {
    const c = await customer();
    const t = await technician();
    const { jobId, visitId } = await book(c, bookingBody(await address(c.userId)));
    await assign(visitId, t);
    await asTech(t, 'POST', `/v1/technician/visits/${visitId}/depart`, { clientReportedAt: h.clock.now().toISOString() });
    const far = { lat: 15.5, lng: 78.5, accuracyM: 10 };
    expect((await asTech(t, 'POST', `/v1/technician/visits/${visitId}/wait/start`, { location: far })).status).toBe(400);
    const loc = localityByCode('LOC-02');
    await asTech(t, 'POST', `/v1/technician/visits/${visitId}/wait/start`, { location: { lat: loc.lat, lng: loc.lon, accuracyM: 10 } });
    h.clock.advance(19 * 60_000);
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('EN_ROUTE');
    h.clock.advance(2 * 60_000);
    await h.api.jobs.sweep();
    expect(await visitStatus(visitId)).toBe('CUSTOMER_NO_SHOW');
    expect(await jobStatus(jobId)).toMatchObject({ status: 'AWAITING_PAYMENT' });
    const event = await row("SELECT payload FROM platform.outbox WHERE aggregate_id = $1 AND event_type = 'VisitNoShow'", [visitId]);
    expect(event['payload']).toMatchObject({ feePaise: 9900, billId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});
