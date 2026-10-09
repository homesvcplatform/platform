// Gate 6 test kit: synthetic customers / technicians / addresses, an on-site REFRIGERATOR diagnosis visit, and the
// diagnosis → quote → decision steps through the api handlers. Shared by the Gate 6 DB tests. Synthetic data only;
// fixture prices are NOT FINAL.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect } from 'vitest';
import { newId } from '@hsp/kernel';
import { subjectKeyStore } from '@hsp/module-identity';
import type { Actor } from '@hsp/policy';
import { blindIndex, createFieldCrypto } from '@hsp/security';
import { kurnool } from '@hsp/testing';
import { meta, ORIGIN, testPhone, type ApiHarness } from './harness.ts';

const { CITY, serviceTypeId, specializationId, localityByCode, fixtureRowId } = kurnool;
export const VISIT_FEE = 19_900; // MODEL_B fixture (NOT FINAL): no visit-fee credit, no platform fee
export const REP_THERMO = fixtureRowId('catalog.repair_items', 'REP-FRIDGE-THERMOSTAT-REPLACE'); // labour 34 000 (fixture)
export const REP_AC = fixtureRowId('catalog.repair_items', 'REP-AC-CAPACITOR-REPLACE');
export const MAT_THERMO = fixtureRowId('catalog.materials', 'MAT-FRIDGE-THERMOSTAT'); // reference 60 000 (fixture)
export const MAT_GAS = fixtureRowId('catalog.materials', 'MAT-REFRIGERANT-R600A'); // reference 90 000 / kg (fixture)
export const LABOUR_THERMO = 34_000;
export const HOUR = 3_600_000;
export const MIN = 60_000;

export interface Customer { cookie: string; csrf: string; userId: string }
export interface Technician { token: string; userId: string; phone: string; issuedAt: number }
export interface OnSite { c: Customer; t: Technician; jobId: string; visitId: string }
export interface Submitted { diagnosisId: string; quoteVersionId: string; versionNo: number; totalPayablePaise: number; previewHash: string }

export const draft = (over: Record<string, unknown> = {}) => ({
  expectedVersion: 0, problemCode: 'THERMOSTAT_FAULT', observedChips: ['NO_COOLING'], severity: 'MODERATE', safetyAdviceCode: null,
  items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }, { type: 'MATERIAL', materialId: MAT_THERMO, qty: 1 }] as unknown[],
  noRepairNeeded: false, sameVisitFeasible: true, materialAvailableNow: true, ...over,
});

export function gate6Kit(h: ApiHarness, apiPool: pg.Pool) {
  const identity = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.api.http({ method, path, headers, body, meta: meta() });

  async function otp(phone: string) {
    const r = await identity('POST', '/v1/auth/otp/request', { phone, purpose: 'LOGIN', locale: 'te-IN' });
    const challengeId = (r.body as { challengeId: string }).challengeId;
    return { challengeId, code: h.sms.codeFor(challengeId) ?? '' };
  }

  const userIdOf = async (phone: string) =>
    (await h.db.admin.query('SELECT id FROM identity.users WHERE phone_bidx = $1', [blindIndex(h.keys.blindIndexPepper, phone)])).rows[0]?.id as string;

  async function customer(): Promise<Customer> {
    const phone = testPhone();
    const o = await otp(phone);
    const r = await identity('POST', '/v1/auth/otp/verify', { challengeId: o.challengeId, code: o.code, surface: 'CUSTOMER_WEB', device: { platform: 'WEB' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { cookie: (r.headers['set-cookie'] ?? '').split(';')[0] ?? '', csrf: (r.body as { csrfToken: string }).csrfToken, userId: await userIdOf(phone) };
  }

  async function appSession(phone: string, userId: string): Promise<Technician> {
    h.clock.advance(31_000); // OTP resend cooldown
    const o = await otp(phone);
    const r = await identity('POST', '/v1/auth/otp/verify', { challengeId: o.challengeId, code: o.code, surface: 'TECHNICIAN_APP',
      device: { platform: 'ANDROID_APP', appVersion: '1.0.0' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { token: (r.body as { accessToken: string }).accessToken, userId, phone, issuedAt: h.clock.now().getTime() };
  }

  /** A refrigerator technician with verified (ASSESSED) skills: the base skill plus `specializations`. */
  async function technician(specializations: string[] = ['THERMOSTAT']): Promise<Technician> {
    const phone = testPhone();
    await otp(phone);
    const userId = await userIdOf(phone);
    h.technicians.add(userId);
    await h.db.migrator.query(`INSERT INTO workforce.technician_profiles (user_id, legal_name_enc, display_name, device_mode, city_id, home_locality_id,
        languages, birth_year, onboarding_status, status, capacity, ivr_locale)
      VALUES ($1, $2, 'Test Technician', 'SMARTPHONE', $3, $4, '{te}', 1990, 'READY', 'ACTIVE', 5, 'te-IN')`,
    [userId, randomBytes(24), CITY.id, localityByCode('LOC-02').id]);
    for (const s of [null, ...specializations]) {
      await h.db.migrator.query(`INSERT INTO workforce.technician_skills (id, technician_user_id, service_type_id, specialization_id, level, can_diagnose,
          can_repair, verified_by_admin_id, verified_at, status) VALUES ($1, $2, $3, $4, 'ASSESSED', true, true, $5, now(), 'ACTIVE')`,
      [newId(), userId, serviceTypeId('REFRIGERATOR'), s ? specializationId('REFRIGERATOR', s) : null, kurnool.ADMINS.checker]);
    }
    return appSession(phone, userId);
  }

  async function address(customerUserId: string): Promise<string> {
    const crypto = createFieldCrypto({ kms: h.keyring.forRole('api'), store: subjectKeyStore(apiPool), clock: h.clock });
    const ctx = { subjectId: customerUserId, dataClass: 'pii-address' as const };
    const id = newId();
    await h.db.migrator.query(`INSERT INTO customers.addresses (id, customer_user_id, city_id, locality_id, line1_enc, landmark_enc)
      VALUES ($1, $2, $3, $4, $5, $6)`, [id, customerUserId, CITY.id, localityByCode('LOC-02').id, await crypto.seal(ctx, 'Flat 9, Synthetic Towers'),
      await crypto.seal(ctx, 'Near the test park')]);
    return id;
  }

  function slot(hoursAhead: number) {
    const step = 30 * MIN;
    const start = new Date(Math.ceil((h.clock.now().getTime() + hoursAhead * HOUR) / step) * step);
    return { type: 'SLOT' as const, start: start.toISOString(), end: new Date(start.getTime() + 2 * HOUR).toISOString() };
  }

  const headersOf = (c: Customer, key: string | null) => ({ cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': c.csrf, ...(key ? { 'idempotency-key': key } : {}) });
  const asCustomer = (c: Customer, method: string, path: string, body?: unknown, key: string | null = randomUUID()) =>
    h.api.jobsHttp({ method, path, body, meta: meta(), headers: headersOf(c, key) });
  const asCustomerD = (c: Customer, method: string, path: string, body?: unknown, key: string | null = randomUUID()) =>
    h.api.diagnosisHttp({ method, path, body, meta: meta(), headers: headersOf(c, key) });

  async function techHeaders(t: Technician, key: string | null) {
    if (h.clock.now().getTime() - t.issuedAt > 8 * MIN) Object.assign(t, await appSession(t.phone, t.userId));
    return { authorization: `Bearer ${t.token}`, ...(key ? { 'idempotency-key': key } : {}) };
  }
  const asTech = async (t: Technician, method: string, path: string, body?: unknown, key: string | null = randomUUID()) =>
    h.api.jobsHttp({ method, path, body, meta: meta(), headers: await techHeaders(t, key) });
  const asTechD = async (t: Technician, method: string, path: string, body?: unknown, key: string | null = randomUUID()) =>
    h.api.diagnosisHttp({ method, path, body, meta: meta(), headers: await techHeaders(t, key) });

  const ops: Actor = { kind: 'ADMIN', id: newId(), sessionId: newId(), surface: 'ADMIN',
    permissions: new Map([['dispatch.assign', [{ kind: 'CITIES', cityIds: [CITY.id] }]]]) };
  const assign = (visitId: string, t: Technician) => h.api.jobs.assignManually(ops, visitId, { technicianUserId: t.userId, reasonCode: 'TEST_ASSIGN' }, randomUUID(), meta());
  const row = async (sql: string, params: unknown[]) => (await h.db.migrator.query(sql, params)).rows[0] as Record<string, unknown>;
  const rows = async (sql: string, params: unknown[]) => (await h.db.migrator.query(sql, params)).rows as Record<string, unknown>[];
  const status = async (table: string, id: string) => (await row(`SELECT status FROM ${table} WHERE id = $1`, [id]))['status'];

  async function code(c: Customer, visitId: string, kind: 'start-code' | 'completion-code'): Promise<string> {
    const r = await asCustomer(c, 'POST', `/v1/customer/visits/${visitId}/${kind}`, {}, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { startCode?: string; completionCode?: string }).startCode ?? (r.body as { completionCode: string }).completionCode;
  }

  async function arrive(c: Customer, t: Technician, visitId: string) {
    const r = await asTech(t, 'POST', `/v1/technician/visits/${visitId}/arrive`, { startCode: await code(c, visitId, 'start-code'), clientReportedAt: h.clock.now().toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** A booked REFRIGERATOR job whose diagnosis visit is IN_PROGRESS with technician `t`. */
  async function onSite(t?: Technician): Promise<OnSite> {
    const c = await customer();
    const tech = t ?? (await technician());
    const r = await asCustomer(c, 'POST', '/v1/customer/jobs', {
      clientRequestId: randomUUID(), serviceTypeId: serviceTypeId('REFRIGERATOR'), symptomCodes: ['NOT_COOLING'], addressId: await address(c.userId),
      timing: { type: 'ASAP' }, acceptedVisitFeePaise: VISIT_FEE, paymentPreference: 'EITHER', onsiteAdult: 'SELF', confirmSeparate: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const b = r.body as { jobId: string; visits: { visitId: string }[] };
    const visitId = b.visits[0]?.visitId ?? '';
    await assign(visitId, tech);
    await arrive(c, tech, visitId);
    return { c, t: tech, jobId: b.jobId, visitId };
  }

  async function draftFor(t: Technician, visitId: string, content = draft(), kind: 'INITIAL' | 'ADDITIONAL_FINDING' = 'INITIAL') {
    const created = await asTechD(t, 'POST', `/v1/technician/visits/${visitId}/diagnoses`, { kind });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { diagnosisId, version } = created.body as { diagnosisId: string; version: number };
    const put = await asTechD(t, 'PUT', `/v1/technician/diagnoses/${diagnosisId}`, { ...content, expectedVersion: version });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return { diagnosisId, version: (put.body as { version: number }).version };
  }

  async function diagnose(s: { t: Technician; visitId: string }, content = draft(), kind: 'INITIAL' | 'ADDITIONAL_FINDING' = 'INITIAL'): Promise<Submitted> {
    const d = await draftFor(s.t, s.visitId, content, kind);
    let previewHash = '';
    if (!content.noRepairNeeded) {
      const preview = await asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d.diagnosisId}/quote-preview`, {}, null);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      previewHash = (preview.body as { previewHash: string }).previewHash;
    }
    const submit = await asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d.diagnosisId}/submit`,
      { expectedVersion: d.version, ...(previewHash ? { previewHash } : {}) });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    return { ...(submit.body as Omit<Submitted, 'previewHash'>), previewHash };
  }

  const quoteOf = async (c: Customer, jobId: string) => {
    const r = await asCustomerD(c, 'GET', `/v1/customer/jobs/${jobId}/quote`, undefined, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { quoteVersionId: string; contentHash: string; status: string; totals: { totalPayablePaise: number }; lines: { type: string; amountPaise: number }[];
      repairOptions: { option: string; available: boolean; reasonKey: string | null }[]; previousApproved?: { versionNo: number } };
  };

  const approve = (c: Customer, versionId: string, contentHash: string, repairPreference = 'RECOMMENDED_SPECIALIST', key: string = randomUUID()) =>
    asCustomerD(c, 'POST', `/v1/customer/quote-versions/${versionId}/approve`, { contentHash, repairPreference, allowFallback: true }, key);

  const repairOrder = async (jobId: string) => row('SELECT * FROM jobs.repair_orders WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1', [jobId]);
  const event = async (aggregateId: string, type: string) =>
    row('SELECT id, payload FROM platform.outbox WHERE aggregate_id = $1 AND event_type = $2 ORDER BY occurred_at DESC LIMIT 1', [aggregateId, type]);

  return {
    identity, customer, technician, appSession, address, slot, headersOf, asCustomer, asCustomerD, techHeaders, asTech, asTechD, assign, row, rows, status, code,
    arrive, onSite, draftFor, diagnose, quoteOf, approve, repairOrder, event,
  };
}

export type Gate6Kit = ReturnType<typeof gate6Kit>;
