// Gate 6 exit criteria through the api composition (Phase 1 04 §10–§12, 06 §3 / §6–§8, ADR-027): server-side pricing
// with immutable, hash-bound quote versions (INV-05, INV-06, INV-07, INV-21), customer-only decisions on the own channel
// (INV-08, step-up, SR-05 signed link + OTP), Q-A repair options and the same-visit guard, repair orders created from
// QuoteApproved by the jobs consumer through the real outbox relay (worker role), change orders (no work on new items
// before approval), completion with the code (INV-15), TCP-2 material usage and TCP-3 bills (INV-09), expiry, checkout,
// concurrency and idempotency. Throwaway database, synthetic people, fixture prices (NOT FINAL), fake SMS / links.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOutboxRelay, type OutboxEvent, type OutboxRelay } from '@hsp/events';
import { newId } from '@hsp/kernel';
import { completionOverrideChangeAction } from '@hsp/module-jobs';
import { createLogger } from '@hsp/observability';
import type { Actor } from '@hsp/policy';
import { kurnool, loadSyntheticSeed } from '@hsp/testing';
import type { ApiComposition } from '../bootstrap.ts';
import {
  draft, gate6Kit, HOUR, LABOUR_THERMO, MAT_GAS, MAT_THERMO, MIN, REP_AC, REP_THERMO, VISIT_FEE, type Customer, type Gate6Kit, type Technician,
} from './gate6-kit.ts';
import { createApiHarness, meta, type ApiHarness } from './harness.ts';

let h: ApiHarness;
let apiPool: pg.Pool;
let workerPool: pg.Pool;
let worker: ApiComposition;
let relay: OutboxRelay;

beforeAll(async () => {
  h = await createApiHarness();
  await loadSyntheticSeed(h.db.migrator);
  apiPool = new pg.Pool({ connectionString: await h.db.loginFor('app_api'), max: 3 });
  workerPool = new pg.Pool({ connectionString: await h.db.loginFor('app_worker'), max: 4 });
  worker = await h.role('app_worker', 'worker');
  k = gate6Kit(h, apiPool);
  relay = createOutboxRelay({ pool: workerPool, consumers: [worker.jobs.eventConsumer()], logger: createLogger('hsp-relay-test', 'error', () => undefined), retryAfterMs: 0 });
});
afterAll(async () => {
  await apiPool?.end();
  await workerPool?.end();
  await h?.close();
});

// ---------------------------------------------------------------- helpers (gate6-kit.ts)

let k: Gate6Kit;
const { CITY } = kurnool;
const customer = () => k.customer();
const technician = (specs?: string[]) => k.technician(specs);
const slot = (hours: number) => k.slot(hours);
const headersOf = (c: Customer, key: string | null) => k.headersOf(c, key);
const asCustomer = (c: Customer, method: string, path: string, body?: unknown, key: string | null = randomUUID()) => k.asCustomer(c, method, path, body, key);
const asCustomerD = (c: Customer, method: string, path: string, body?: unknown, key: string | null = randomUUID()) => k.asCustomerD(c, method, path, body, key);
const techHeaders = (t: Technician, key: string | null) => k.techHeaders(t, key);
const asTech = (t: Technician, method: string, path: string, body?: unknown, key: string | null = randomUUID()) => k.asTech(t, method, path, body, key);
const asTechD = (t: Technician, method: string, path: string, body?: unknown, key: string | null = randomUUID()) => k.asTechD(t, method, path, body, key);
const assign = (visitId: string, t: Technician) => k.assign(visitId, t);
const row = (sql: string, params: unknown[]) => k.row(sql, params);
const rows = (sql: string, params: unknown[]) => k.rows(sql, params);
const status = (table: string, id: string) => k.status(table, id);
const code = (c: Customer, visitId: string, kind: 'start-code' | 'completion-code') => k.code(c, visitId, kind);
const arrive = (c: Customer, t: Technician, visitId: string) => k.arrive(c, t, visitId);
const onSite = (t?: Technician) => k.onSite(t);
const draftFor = (t: Technician, visitId: string, content = draft(), kind: 'INITIAL' | 'ADDITIONAL_FINDING' = 'INITIAL') => k.draftFor(t, visitId, content, kind);
const diagnose = (s: { t: Technician; visitId: string }, content = draft(), kind: 'INITIAL' | 'ADDITIONAL_FINDING' = 'INITIAL') => k.diagnose(s, content, kind);
const quoteOf = (c: Customer, jobId: string) => k.quoteOf(c, jobId);
const approve = (c: Customer, versionId: string, contentHash: string, repairPreference = 'RECOMMENDED_SPECIALIST', key: string = randomUUID()) =>
  k.approve(c, versionId, contentHash, repairPreference, key);
const repairOrder = (jobId: string) => k.repairOrder(jobId);
const event = (aggregateId: string, type: string) => k.event(aggregateId, type);
const identity = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => k.identity(method, path, body, headers);

// ---------------------------------------------------------------- diagnosis, pricing and presentation

describe('diagnosis and presentation (04 §10, 06 §6–§7)', () => {
  it('the assigned technician drafts, previews and submits; the server prices; the version is presented, hashed and immutable', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    expect(sub).toMatchObject({ versionNo: 1, totalPayablePaise: VISIT_FEE + LABOUR_THERMO + 60_000 });
    const v = await row(`SELECT v.status, v.content_hash, v.total_payable_paise, v.expires_at, v.presented_at, p.engine_version, p.inputs, p.outputs
      FROM diagnosis.quote_versions v JOIN pricing.price_snapshots p ON p.id = v.price_snapshot_id WHERE v.id = $1`, [sub.quoteVersionId]);
    expect(v).toMatchObject({ status: 'PRESENTED', engine_version: 'gate6-quote-1', total_payable_paise: String(sub.totalPayablePaise) });
    expect((v['content_hash'] as Buffer).toString('hex')).toBe(sub.previewHash);
    expect((v['expires_at'] as Date).getTime() - (v['presented_at'] as Date).getTime()).toBe(48 * HOUR); // service rule fixture (NOT FINAL)
    const items = await rows('SELECT item_type, amount_paise, technician_share_paise FROM diagnosis.quote_items WHERE quote_version_id = $1 ORDER BY line_no', [sub.quoteVersionId]);
    expect(items.map((i) => [i['item_type'], Number(i['amount_paise'])])).toEqual([['VISIT_FEE', VISIT_FEE], ['LABOUR', LABOUR_THERMO], ['MATERIAL', 60_000]]);
    const view = await quoteOf(s.c, s.jobId);
    expect(view).toMatchObject({ quoteVersionId: sub.quoteVersionId, status: 'PRESENTED', contentHash: sub.previewHash, totals: { totalPayablePaise: sub.totalPayablePaise } });
    expect(view.repairOptions.filter((o) => o.available).map((o) => o.option)).toEqual(['SAME_VISIT', 'SAME_TECHNICIAN', 'RECOMMENDED_SPECIALIST']);
    // history (INV-18), outbox, audit, expiry timer, link delivered to the customer only
    expect((await rows('SELECT to_status, actor_type FROM diagnosis.quote_version_status_history WHERE quote_version_id = $1', [sub.quoteVersionId]))
      .map((x) => `${x['to_status']}:${x['actor_type']}`).sort()).toEqual(['DRAFT:TECHNICIAN', 'PRESENTED:TECHNICIAN']);
    expect(await event(String((await row('SELECT quote_id FROM diagnosis.quote_versions WHERE id = $1', [sub.quoteVersionId]))['quote_id']), 'QuoteVersionPresented'))
      .toMatchObject({ payload: { jobId: s.jobId, quoteVersionId: sub.quoteVersionId, changeOrder: false } });
    expect(await row("SELECT count(*)::int AS n FROM compliance.audit_logs WHERE action IN ('diagnosis.submitted', 'quote.version_presented') AND resource_id IN ($1, $2)",
      [sub.diagnosisId, sub.quoteVersionId])).toEqual({ n: 2 });
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`quote_version:${sub.quoteVersionId}:expire`])).toEqual({ n: 1 });
    expect(h.quoteLinks.get(sub.quoteVersionId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.logs.some((l) => l.includes(h.quoteLinks.get(sub.quoteVersionId) ?? '-'))).toBe(false); // SR-05: never logged
    // the relay moves the job to AWAITING_APPROVAL and schedules the auto-checkout
    await relay.drain();
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_APPROVAL');
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`visit:${s.visitId}:autoCheckout`])).toEqual({ n: 1 });
  });

  it('the client never sets prices: a stale preview is re-priced (409), unknown problems / foreign items are refused, custom labour is out of band (422), a deviating material price needs a reason', async () => {
    const s = await onSite();
    const d = await draftFor(s.t, s.visitId);
    expect((await asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d.diagnosisId}/submit`, { expectedVersion: d.version, previewHash: '0'.repeat(64) })).body)
      .toMatchObject({ code: 'PRICE_RECALCULATED' });
    const put = (content: Record<string, unknown>) => asTechD(s.t, 'PUT', `/v1/technician/diagnoses/${d.diagnosisId}`, content);
    expect((await put(draft({ expectedVersion: d.version, problemCode: 'NOT_COOLING' }))).body).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'problemCode' }] });
    expect((await put(draft({ expectedVersion: d.version, items: [{ type: 'REPAIR_ITEM', repairItemId: REP_AC, qty: 1 }] }))).body)
      .toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'items.0.repairItemId' }] });
    expect((await put(draft({ expectedVersion: d.version, items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1, unitPricePaise: 1 }] }))).status).toBe(400);
    expect((await put(draft({ expectedVersion: d.version + 7 }))).body).toMatchObject({ code: 'STALE_VERSION' });
    let version = d.version;
    const set = async (content: Record<string, unknown>) => {
      const r = await put({ ...content, expectedVersion: version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      version = (r.body as { version: number }).version;
      return asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d.diagnosisId}/quote-preview`, {}, null);
    };
    const custom = await set(draft({ items: [{ type: 'CUSTOM_LABOUR', qty: 1, proposedUnitPricePaise: 20_000, reasonCode: 'EXTRA_ACCESS_WORK' }] }));
    expect(custom.status).toBe(422);
    expect(custom.body).toMatchObject({ code: 'CUSTOM_LABOUR_OUT_OF_BAND' });
    const deviating = await set(draft({ items: [{ type: 'MATERIAL', materialId: MAT_THERMO, qty: 1, proposedUnitPricePaise: 90_000 }] }));
    expect(deviating.body).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'items.0.reasonCode', code: 'REQUIRED' }] });
    const reasoned = await set(draft({ items: [{ type: 'MATERIAL', materialId: MAT_THERMO, qty: 1, proposedUnitPricePaise: 90_000, reasonCode: 'BRANDED_PART' }] }));
    expect(reasoned.body).toMatchObject({ totals: { totalPayablePaise: VISIT_FEE + 90_000 } });
  });

  it('only the ACTIVE assignee writes; another technician and customers get 404; INV-05 holds at SQL level for the api role', async () => {
    const s = await onSite();
    const other = await technician();
    const cust = await customer();
    expect((await asTechD(other, 'POST', `/v1/technician/visits/${s.visitId}/diagnoses`, { kind: 'INITIAL' })).status).toBe(404);
    expect((await asCustomerD(cust, 'POST', `/v1/technician/visits/${s.visitId}/diagnoses`, { kind: 'INITIAL' })).status).toBe(404);
    const sub = await diagnose(s);
    const client = await apiPool.connect();
    try {
      const probe = async (sql: string, params: unknown[]) => {
        await client.query('BEGIN');
        try {
          await client.query(sql, params);
          return 'OK';
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await client.query('ROLLBACK');
        }
      };
      expect(await probe('UPDATE diagnosis.quote_items SET amount_paise = 1, unit_price_paise = 1 WHERE quote_version_id = $1', [sub.quoteVersionId])).toBe('42501');
      expect(await probe('DELETE FROM diagnosis.quote_items WHERE quote_version_id = $1', [sub.quoteVersionId])).toBe('42501');
      expect(await probe('UPDATE diagnosis.quote_versions SET total_payable_paise = 1, items_total_paise = 1 WHERE id = $1', [sub.quoteVersionId])).toBe('HS002');
      expect(await probe(`INSERT INTO diagnosis.quote_items (id, quote_version_id, line_no, item_type, label_key, qty, unit_price_paise, amount_paise)
        VALUES ($1, $2, 9, 'DISCOUNT', 'x', 1, 5, 5)`, [newId(), sub.quoteVersionId])).toBe('HS002');
      expect(await probe('UPDATE pricing.price_snapshots SET outputs = $2 WHERE id = (SELECT price_snapshot_id FROM diagnosis.quote_versions WHERE id = $1)',
        [sub.quoteVersionId, '{}'])).toBe('42501');
    } finally {
      client.release();
    }
  });

  it('a correcting diagnosis before any decision supersedes the first; v1 is WITHDRAWN and can no longer be approved (INV-06)', async () => {
    const s = await onSite();
    const v1 = await diagnose(s);
    const v2 = await diagnose(s, draft({ items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }] }));
    expect(v2).toMatchObject({ versionNo: 2, totalPayablePaise: VISIT_FEE + LABOUR_THERMO });
    expect(await status('diagnosis.quote_versions', v1.quoteVersionId)).toBe('WITHDRAWN');
    expect(await status('diagnosis.diagnoses', v1.diagnosisId)).toBe('SUPERSEDED');
    expect((await approve(s.c, v1.quoteVersionId, v1.previewHash)).body).toMatchObject({ code: 'QUOTE_CHANGED', details: { latestVersionNo: 2 } });
    expect((await approve(s.c, v2.quoteVersionId, v1.previewHash)).body).toMatchObject({ code: 'QUOTE_CHANGED' }); // stale hash
    expect((await approve(s.c, v2.quoteVersionId, v2.previewHash)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- decisions

describe('customer decisions (INV-06, INV-07, INV-08, step-up)', () => {
  it('only the job owner decides, from the own session; the decision is recorded once with its evidence; a second decision is refused', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    const stranger = await customer();
    expect((await approve(stranger, sub.quoteVersionId, sub.previewHash)).status).toBe(404);
    expect((await h.api.diagnosisHttp({ method: 'POST', path: `/v1/customer/quote-versions/${sub.quoteVersionId}/approve`, meta: meta(),
      headers: { ...(await techHeaders(s.t, randomUUID())) }, body: { contentHash: sub.previewHash, repairPreference: 'SAME_VISIT', allowFallback: true } })).status).toBe(404);
    const key = randomUUID();
    const ok = await approve(s.c, sub.quoteVersionId, sub.previewHash, 'RECOMMENDED_SPECIALIST', key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'RECOMMENDED_SPECIALIST', key)).body).toEqual(ok.body); // replay
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash)).body).toMatchObject({ code: 'QUOTE_CHANGED' });
    expect(await row('SELECT decision, channel, customer_user_id, session_id IS NOT NULL AS has_session, repair_preference FROM diagnosis.quote_approvals WHERE quote_version_id = $1',
      [sub.quoteVersionId])).toEqual({ decision: 'APPROVED', channel: 'APP_SESSION', customer_user_id: s.c.userId, has_session: true, repair_preference: 'RECOMMENDED_SPECIALIST' });
    expect(await row('SELECT approved_version_id FROM diagnosis.quotes WHERE job_id = $1', [s.jobId])).toEqual({ approved_version_id: sub.quoteVersionId });
    expect(await row("SELECT actor_type, channel FROM diagnosis.quote_version_status_history WHERE quote_version_id = $1 AND to_status = 'APPROVED'", [sub.quoteVersionId]))
      .toEqual({ actor_type: 'CUSTOMER', channel: 'PWA' });
  });

  it('a quote above the high-value threshold needs a fresh OTP step-up (05 §2.1)', async () => {
    const s = await onSite();
    const sub = await diagnose(s, draft({ items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }, { type: 'MATERIAL', materialId: MAT_THERMO, qty: 5 }] }));
    expect(sub.totalPayablePaise).toBeGreaterThan(300_000);
    const denied = await approve(s.c, sub.quoteVersionId, sub.previewHash);
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    h.clock.advance(31_000);
    const req = await identity('POST', '/v1/auth/step-up/otp', {}, headersOf(s.c, null));
    const challengeId = (req.body as { challengeId: string }).challengeId;
    expect((await identity('POST', '/v1/auth/step-up', { challengeId, code: h.sms.codeFor(challengeId) }, headersOf(s.c, null))).status).toBe(204);
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash)).status).toBe(200);
  });

  it('Q-A: a diagnosing technician without the required specialization is offered only the specialist path', async () => {
    const s = await onSite(await technician([]));
    const sub = await diagnose(s);
    const view = await quoteOf(s.c, s.jobId);
    expect(view.repairOptions.filter((o) => o.available).map((o) => o.option)).toEqual(['RECOMMENDED_SPECIALIST']);
    expect(view.repairOptions.find((o) => o.option === 'SAME_TECHNICIAN')?.reasonKey).toBe('quote.option.reason.technician_not_qualified');
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'SAME_TECHNICIAN')).body).toMatchObject({ code: 'OPTION_UNAVAILABLE' });
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'SAME_VISIT')).body).toMatchObject({ code: 'OPTION_UNAVAILABLE' });
  });

  it('a rejection closes the work: the job awaits payment of the visit fee, billed through TCP-3', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    const r = await asCustomerD(s.c, 'POST', `/v1/customer/quote-versions/${sub.quoteVersionId}/reject`, { contentHash: sub.previewHash, reasonCode: 'TOO_EXPENSIVE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await relay.drain();
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_PAYMENT');
    expect(await event(s.jobId, 'JobAwaitingPayment')).toMatchObject({ payload: { reason: 'QUOTE_REJECTED', billId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(await repairOrder(s.jobId)).toBeUndefined();
  });

  it('expiry (T:quote_expire, sweeper): past 48 h the version EXPIRES, the visit fee is due, approving is refused', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    h.clock.advance(48 * HOUR + MIN);
    expect((await h.api.diagnosis.sweep()).quoteExpire).toBeGreaterThanOrEqual(1);
    expect(await status('diagnosis.quote_versions', sub.quoteVersionId)).toBe('EXPIRED');
    await relay.drain();
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_PAYMENT');
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash)).body).toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('concurrency: an approval racing a new version, and two approvals racing each other - exactly one wins (INV-07)', async () => {
    const s = await onSite();
    const v1 = await diagnose(s);
    const d2 = await draftFor(s.t, s.visitId, draft({ items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }] }));
    const preview = (await asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d2.diagnosisId}/quote-preview`, {}, null)).body as { previewHash: string };
    const [a, b] = await Promise.all([
      approve(s.c, v1.quoteVersionId, v1.previewHash),
      asTechD(s.t, 'POST', `/v1/technician/diagnoses/${d2.diagnosisId}/submit`, { expectedVersion: d2.version, previewHash: preview.previewHash }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const states = await rows("SELECT status FROM diagnosis.quote_versions v JOIN diagnosis.quotes q ON q.id = v.quote_id WHERE q.job_id = $1", [s.jobId]);
    expect(states.filter((x) => x['status'] === 'APPROVED').length + states.filter((x) => x['status'] === 'PRESENTED').length).toBe(1);

    const s2 = await onSite();
    const w = await diagnose(s2);
    const both = await Promise.all([approve(s2.c, w.quoteVersionId, w.previewHash), approve(s2.c, w.quoteVersionId, w.previewHash, 'SAME_TECHNICIAN')]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await row('SELECT count(*)::int AS n FROM diagnosis.quote_approvals WHERE quote_version_id = $1', [w.quoteVersionId])).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------- repair orders, completion, change orders

async function completeRepair(s: { c: Customer; t: Technician }, visitId: string, usage: { quoteItemId: string; qtyUsed: number }[], outcome = 'COMPLETE',
  extra: Record<string, unknown> = {}) {
  return asTech(s.t, 'POST', `/v1/technician/visits/${visitId}/complete`, { completionCode: await code(s.c, visitId, 'completion-code'), outcome,
    materialUsage: usage, ...extra });
}

const materialLines = async (versionId: string) =>
  (await rows("SELECT id, qty FROM diagnosis.quote_items WHERE quote_version_id = $1 AND item_type = 'MATERIAL' ORDER BY line_no", [versionId]))
    .map((r) => ({ quoteItemId: r['id'] as string, qty: Number(r['qty']) }));

describe('repair orders from approvals (06 §3, §8; async QuoteApproved → jobs)', () => {
  it('same visit: the order is attached to the diagnosis visit; completion with the code records usage (TCP-2) and bills approved − unused (TCP-3, INV-09)', async () => {
    const s = await onSite();
    const sub = await diagnose(s, draft({ items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }, { type: 'MATERIAL', materialId: MAT_THERMO, qty: 2 }] }));
    h.clock.advance(10 * MIN);
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'SAME_VISIT')).status).toBe(200);
    await relay.drain();
    const ro = await repairOrder(s.jobId);
    expect(ro).toMatchObject({ status: 'IN_PROGRESS', performer_preference: 'SAME_VISIT', quote_version_id: sub.quoteVersionId, materials_supplied_by: 'TECHNICIAN' });
    expect(await row('SELECT purposes, repair_order_id, required_capability FROM jobs.visits WHERE id = $1', [s.visitId]))
      .toEqual({ purposes: ['DIAGNOSIS', 'REPAIR'], repair_order_id: ro['id'], required_capability: 'DIAGNOSE_AND_REPAIR' });
    expect(await status('jobs.jobs', s.jobId)).toBe('REPAIR_IN_PROGRESS');
    expect((await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/checkout`, {})).status).toBe(409); // a repair visit completes with the code
    const [mat] = await materialLines(sub.quoteVersionId);
    expect((await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/complete`, { completionCode: '0000', outcome: 'COMPLETE',
      materialUsage: [{ quoteItemId: mat?.quoteItemId, qtyUsed: 1 }] })).body).toMatchObject({ code: 'CODE_INCORRECT', details: { attemptsLeft: 4 } });
    expect((await completeRepair(s, s.visitId, [{ quoteItemId: mat?.quoteItemId ?? '', qtyUsed: 3 }])).body).toMatchObject({ code: 'VALIDATION_FAILED' }); // above quoted
    const done = await completeRepair(s, s.visitId, [{ quoteItemId: mat?.quoteItemId ?? '', qtyUsed: 1 }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ visitStatus: 'COMPLETED', repairOrderStatus: 'COMPLETED', amountDuePaise: sub.totalPayablePaise - 60_000 });
    expect(await status('jobs.repair_orders', ro['id'] as string)).toBe('COMPLETED');
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_PAYMENT');
    expect(await row('SELECT qty_quoted, qty_used, recorded_by_actor_type FROM diagnosis.material_usage WHERE visit_id = $1', [s.visitId]))
      .toEqual({ qty_quoted: '2.000', qty_used: '1.000', recorded_by_actor_type: 'TECHNICIAN' });
    expect(await row("SELECT count(*)::int AS n FROM jobs.visit_presence_proofs WHERE visit_id = $1 AND kind = 'COMPLETION_CODE'", [s.visitId])).toEqual({ n: 1 });
    expect(await event(ro['id'] as string, 'RepairOrderCompleted')).toMatchObject({ payload: { amountDuePaise: sub.totalPayablePaise - 60_000,
      billId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
  });

  it('same-visit guard: when the visit ended before the order was created, it falls back to the same technician later (reason recorded)', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'SAME_VISIT')).status).toBe(200);
    expect((await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/checkout`, {})).status).toBe(200); // before the consumer ran
    await relay.drain();
    const ro = await repairOrder(s.jobId);
    expect(ro).toMatchObject({ status: 'AWAITING_SCHEDULE', performer_preference: 'SAME_TECHNICIAN', preferred_technician_user_id: s.t.userId });
    expect(await event(ro['id'] as string, 'RepairOrderCreated')).toMatchObject({ payload: { sameVisit: false, sameVisitUnavailableReason: 'VISIT_ENDED' } });
    expect(await status('jobs.jobs', s.jobId)).toBe('REPAIR_PENDING');
    expect(await row('SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1', [`repair_order:${ro['id']}:repairUnscheduled`])).toEqual({ n: 1 });
  });

  async function scheduledRepair() {
    const s = await onSite();
    const sub = await diagnose(s, draft({ items: [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }, { type: 'MATERIAL', materialId: MAT_THERMO, qty: 2 }] }));
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'RECOMMENDED_SPECIALIST')).status).toBe(200);
    expect((await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/checkout`, {})).status).toBe(200);
    await relay.drain();
    const ro = await repairOrder(s.jobId);
    expect(ro).toMatchObject({ status: 'AWAITING_SCHEDULE', performer_preference: 'RECOMMENDED_SPECIALIST' });
    const sched = await asCustomer(s.c, 'POST', `/v1/customer/repair-orders/${ro['id']}/schedule`, { timing: slot(6) });
    expect(sched.status, JSON.stringify(sched.body)).toBe(200);
    const repairVisitId = (sched.body as { visitId: string }).visitId;
    return { ...s, sub, roId: ro['id'] as string, repairVisitId };
  }

  async function repairInProgress() {
    const r = await scheduledRepair();
    const t2 = await technician(['THERMOSTAT']);
    await assign(r.repairVisitId, t2);
    const depart = () => asTech(t2, 'POST', `/v1/technician/visits/${r.repairVisitId}/depart`, { clientReportedAt: h.clock.now().toISOString() });
    expect((await depart()).body).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'materials', code: 'NOT_CONFIRMED' }] });
    const mats = await materialLines(r.sub.quoteVersionId);
    expect((await asTech(t2, 'POST', `/v1/technician/visits/${r.repairVisitId}/materials-confirmed`, { items: mats.map((m) => ({ quoteItemId: m.quoteItemId, have: true })) })).body)
      .toEqual({ materialsConfirmed: true });
    expect((await depart()).status).toBe(200);
    expect(await status('jobs.jobs', r.jobId)).toBe('REPAIR_IN_PROGRESS');
    await arrive(r.c, t2, r.repairVisitId);
    expect(await status('jobs.repair_orders', r.roId)).toBe('IN_PROGRESS');
    return { ...r, t2, mats };
  }

  it('separate repair visit: scheduled by the customer, materials confirmed before departure, arrival starts the order, completion bills', async () => {
    const r = await repairInProgress();
    expect(await row('SELECT purposes, required_capability, sequence_no, completion_code_hash IS NOT NULL AS has_code FROM jobs.visits WHERE id = $1', [r.repairVisitId]))
      .toEqual({ purposes: ['REPAIR'], required_capability: 'REPAIR', sequence_no: 2, has_code: true });
    const done = await completeRepair({ c: r.c, t: r.t2 }, r.repairVisitId, r.mats.map((m) => ({ quoteItemId: m.quoteItemId, qtyUsed: m.qty })));
    expect(done.body).toMatchObject({ repairOrderStatus: 'COMPLETED', amountDuePaise: r.sub.totalPayablePaise });
    expect(await status('jobs.jobs', r.jobId)).toBe('AWAITING_PAYMENT');
  });

  it('partial repair (D6): the order is BLOCKED with the reason, the job back to REPAIR_PENDING, no bill yet', async () => {
    const r = await repairInProgress();
    const partial = await completeRepair({ c: r.c, t: r.t2 }, r.repairVisitId, [], 'PARTIAL', { partialReasonCode: 'PART_UNAVAILABLE' });
    expect(partial.body).toMatchObject({ visitStatus: 'COMPLETED', repairOrderStatus: 'BLOCKED', billId: null });
    expect(await row('SELECT status, blocked_reason_code FROM jobs.repair_orders WHERE id = $1', [r.roId])).toEqual({ status: 'BLOCKED', blocked_reason_code: 'PART_UNAVAILABLE' });
    expect(await status('jobs.jobs', r.jobId)).toBe('REPAIR_PENDING');
    expect(await row('SELECT terminal_reason_code FROM jobs.visits WHERE id = $1', [r.repairVisitId])).toEqual({ terminal_reason_code: 'PARTIAL_WORK' });
  });

  it('change order: no work on new items before approval; approval supersedes v1 and moves the order to v2; a rejected change leaves the approved scope', async () => {
    const r = await repairInProgress();
    const s2 = { t: r.t2, visitId: r.repairVisitId };
    const finding = await diagnose(s2, draft({ problemCode: 'REFRIGERANT_LEAK', items: [{ type: 'MATERIAL', materialId: MAT_GAS, qty: 0.5 }] }), 'ADDITIONAL_FINDING');
    expect(finding).toMatchObject({ versionNo: 2, totalPayablePaise: r.sub.totalPayablePaise + 45_000 });
    await relay.drain();
    expect(await status('jobs.repair_orders', r.roId)).toBe('CHANGE_PENDING');
    expect(await status('jobs.jobs', r.jobId)).toBe('AWAITING_APPROVAL');
    const v2mats = await materialLines(finding.quoteVersionId);
    const blocked = await completeRepair({ c: r.c, t: r.t2 }, r.repairVisitId, v2mats.map((m) => ({ quoteItemId: m.quoteItemId, qtyUsed: m.qty })));
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'CHANGE_PENDING' });
    // INV-04 (approved-quote half, TCP-2): the recorder refuses while a change is pending, and for a version that isn't approved.
    const client = await apiPool.connect();
    try {
      await client.query('BEGIN');
      await expect(h.api.diagnosis.materialUsageRecorder().recordMaterialUsage({ transactionId: 't', db: client }, { repairOrderId: r.roId, visitId: r.repairVisitId,
        quoteVersionId: r.sub.quoteVersionId, recordedBy: { actorType: 'TECHNICIAN', actorId: r.t2.userId }, lines: [] })).rejects.toMatchObject({ code: 'CHANGE_PENDING' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await expect(h.api.diagnosis.materialUsageRecorder().recordMaterialUsage({ transactionId: 't', db: client }, { repairOrderId: r.roId, visitId: r.repairVisitId,
        quoteVersionId: finding.quoteVersionId, recordedBy: { actorType: 'TECHNICIAN', actorId: r.t2.userId }, lines: [] })).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const view = await quoteOf(r.c, r.jobId);
    expect(view).toMatchObject({ quoteVersionId: finding.quoteVersionId, previousApproved: { versionNo: 1 }, repairOptions: [] });
    expect((await approve(r.c, finding.quoteVersionId, finding.previewHash, 'SAME_VISIT')).status).toBe(200); // preference ignored: the order keeps its performer
    await relay.drain();
    expect(await status('diagnosis.quote_versions', r.sub.quoteVersionId)).toBe('SUPERSEDED');
    expect(await row('SELECT status, quote_version_id FROM jobs.repair_orders WHERE id = $1', [r.roId])).toEqual({ status: 'IN_PROGRESS', quote_version_id: finding.quoteVersionId });
    expect(await row("SELECT reason_code FROM jobs.repair_order_status_history WHERE repair_order_id = $1 AND from_status = 'CHANGE_PENDING'", [r.roId]))
      .toEqual({ reason_code: 'QUOTE_APPROVED' });
    // a further change, rejected: v2 stays in force
    const again = await diagnose(s2, draft({ problemCode: 'REFRIGERANT_LEAK', items: [{ type: 'MATERIAL', materialId: MAT_GAS, qty: 0.25 }] }), 'ADDITIONAL_FINDING');
    await relay.drain();
    expect((await asCustomerD(r.c, 'POST', `/v1/customer/quote-versions/${again.quoteVersionId}/reject`, { contentHash: again.previewHash, reasonCode: 'NOT_NEEDED' })).status).toBe(200);
    await relay.drain();
    expect(await row('SELECT status, quote_version_id FROM jobs.repair_orders WHERE id = $1', [r.roId])).toEqual({ status: 'IN_PROGRESS', quote_version_id: finding.quoteVersionId });
    const done = await completeRepair({ c: r.c, t: r.t2 }, r.repairVisitId, v2mats.map((m) => ({ quoteItemId: m.quoteItemId, qtyUsed: m.qty })));
    expect(done.body).toMatchObject({ repairOrderStatus: 'COMPLETED', amountDuePaise: finding.totalPayablePaise });
  });

  it('an approved ops completion override is the audited alternative to the code (INV-15): same usage (TCP-2) and bill (TCP-3), idempotent', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    expect((await approve(s.c, sub.quoteVersionId, sub.previewHash, 'SAME_VISIT')).status).toBe(200);
    await relay.drain();
    const [mat] = await materialLines(sub.quoteVersionId);
    const action = completionOverrideChangeAction(h.api.jobs);
    const change = { visitId: s.visitId, reasonCode: 'CUSTOMER_CONFIRMED_COMPLETION', customerConfirmedByCall: true, outcome: 'COMPLETE',
      materialUsage: [{ quoteItemId: mat?.quoteItemId, qtyUsed: 1 }] };
    const prepared = await action.prepare(change);
    expect(prepared.cityId).toBe(CITY.id);
    await expect(action.prepare({ ...change, customerConfirmedByCall: undefined })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(action.prepare({ ...change, visitId: newId() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const changeRequestId = newId();
    const opsId = newId();
    await action.execute(changeRequestId, prepared.payload, { now: h.clock.now(), actorId: opsId, requestId: randomUUID() });
    await action.execute(changeRequestId, prepared.payload, { now: h.clock.now(), actorId: opsId, requestId: randomUUID() }); // idempotent
    expect(await status('jobs.visits', s.visitId)).toBe('COMPLETED');
    expect(await row("SELECT count(*)::int AS n FROM jobs.visit_presence_proofs WHERE visit_id = $1 AND kind = 'OPS_OVERRIDE_COMPLETION' AND approval_request_id = $2",
      [s.visitId, changeRequestId])).toEqual({ n: 1 });
    expect(await row('SELECT recorded_by_actor_type, recorded_by_actor_id FROM diagnosis.material_usage WHERE visit_id = $1', [s.visitId]))
      .toEqual({ recorded_by_actor_type: 'ADMIN', recorded_by_actor_id: opsId });
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_PAYMENT');
  });

  it('event replay is idempotent: re-delivering QuoteApproved creates no second order (processed_events)', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    await approve(s.c, sub.quoteVersionId, sub.previewHash);
    await relay.drain();
    const quoteId = String((await row('SELECT quote_id FROM diagnosis.quote_versions WHERE id = $1', [sub.quoteVersionId]))['quote_id']);
    const e = await row(`SELECT id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id, city_id, occurred_at
      FROM platform.outbox WHERE aggregate_id = $1 AND event_type = 'QuoteApproved'`, [quoteId]);
    const evt: OutboxEvent = { id: e['id'] as string, type: 'QuoteApproved', schemaVersion: 1, aggregateType: 'Quote', aggregateId: quoteId, aggregateVersion: 1,
      payload: e['payload'] as Record<string, unknown>, correlationId: e['correlation_id'] as string, cityId: e['city_id'] as string, occurredAt: e['occurred_at'] as Date };
    await Promise.all([worker.jobs.eventConsumer().handle(evt), worker.jobs.eventConsumer().handle(evt)]);
    expect(await row('SELECT count(*)::int AS n FROM jobs.repair_orders WHERE job_id = $1', [s.jobId])).toEqual({ n: 1 });
    expect(await row("SELECT count(*)::int AS n FROM platform.processed_events WHERE consumer = 'jobs' AND event_id = $1", [evt.id])).toEqual({ n: 1 });
  });

  it('cancelling an approved repair before departure: the visit fee is due (accepted fee must match), the job is CANCELLED with a bill', async () => {
    const r = await scheduledRepair();
    const view = await asCustomer(r.c, 'GET', `/v1/customer/repair-orders/${r.roId}`, undefined, null);
    expect(view.body).toMatchObject({ status: 'SCHEDULED', cancellationFeePaise: VISIT_FEE, visits: [{ visitId: r.repairVisitId, status: 'PLANNED' }] });
    expect((await asCustomer(r.c, 'POST', `/v1/customer/repair-orders/${r.roId}/cancel`, { reasonCode: 'CHANGED_MIND', acceptedFeePaise: 0 })).body)
      .toMatchObject({ code: 'PRICE_CHANGED', details: { feePaise: VISIT_FEE } });
    const ok = await asCustomer(r.c, 'POST', `/v1/customer/repair-orders/${r.roId}/cancel`, { reasonCode: 'CHANGED_MIND', acceptedFeePaise: VISIT_FEE });
    expect(ok.body).toMatchObject({ status: 'CANCELLED', feePaise: VISIT_FEE, billId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await status('jobs.repair_orders', r.roId)).toBe('CANCELLED');
    expect(await status('jobs.visits', r.repairVisitId)).toBe('CANCELLED');
    expect(await row('SELECT stage, customer_fee_paise FROM jobs.job_cancellations WHERE job_id = $1', [r.jobId])).toEqual({ stage: 'AFTER_APPROVAL', customer_fee_paise: String(VISIT_FEE) });
    expect((await asCustomer(await customer(), 'GET', `/v1/customer/repair-orders/${r.roId}`, undefined, null)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- checkout

describe('diagnosis-visit checkout (06 §3)', () => {
  it('needs a submitted diagnosis; "no repair needed" closes the visit and bills the visit fee', async () => {
    const s = await onSite();
    expect((await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/checkout`, {})).status).toBe(409);
    const sub = await diagnose(s, draft({ problemCode: 'NO_FAULT_FOUND', items: [], noRepairNeeded: true }));
    expect(sub).toMatchObject({ quoteVersionId: null });
    const r = await asTech(s.t, 'POST', `/v1/technician/visits/${s.visitId}/checkout`, {});
    expect(r.body).toMatchObject({ visitStatus: 'COMPLETED', billId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await status('jobs.jobs', s.jobId)).toBe('AWAITING_PAYMENT');
    expect(await row('SELECT status FROM jobs.assignments WHERE visit_id = $1', [s.visitId])).toEqual({ status: 'COMPLETED' });
  });

  it('the system checks out a diagnosis visit after the presentation (auto_checkout, flagged)', async () => {
    const s = await onSite();
    await diagnose(s);
    await relay.drain();
    h.clock.advance(31 * MIN);
    expect(await worker.jobs.onAutoCheckout(s.visitId)).toBe(true);
    expect(await row('SELECT status, terminal_reason_code FROM jobs.visits WHERE id = $1', [s.visitId])).toEqual({ status: 'COMPLETED', terminal_reason_code: 'AUTO_CHECKOUT' });
  });
});

// ---------------------------------------------------------------- signed link + OTP (SR-05)

describe('signed link + OTP to the registered number (SR-05)', () => {
  const link = (path: string, body: unknown, ua = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile') =>
    h.api.diagnosisLinkHttp({ method: 'POST', path, body, meta: meta(), headers: { 'user-agent': ua } });

  it('preview agents see nothing; the customer views, gets a code on the registered number, decides once; a replay is refused', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    const token = h.quoteLinks.get(sub.quoteVersionId) ?? '';
    expect((await link('/v1/links/quotes/view', { token }, 'WhatsApp/2.23.20')).body).toEqual({ generic: true });
    const view = await link('/v1/links/quotes/view', { token });
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    expect(view.body).toMatchObject({ generic: false, quote: { quoteVersionId: sub.quoteVersionId, contentHash: sub.previewHash } });
    expect(JSON.stringify(view.body)).not.toMatch(/Synthetic Towers|addressText/);
    expect((await link('/v1/links/quotes/view', { token: 'A'.repeat(43) })).status).toBe(404);
    h.clock.advance(31_000);
    const sent = await link('/v1/links/quotes/otp', { token });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const challengeId = (sent.body as { challengeId: string }).challengeId;
    const decide = (otpCode: string) => link('/v1/links/quotes/decision', { token, challengeId, code: otpCode, decision: 'APPROVE', contentHash: sub.previewHash,
      repairPreference: 'RECOMMENDED_SPECIALIST', allowFallback: true });
    const right = h.sms.codeFor(challengeId) ?? '';
    expect((await decide(right === '000000' ? '111111' : '000000')).body).toMatchObject({ code: 'OTP_INVALID' });
    const ok = await decide(right);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await decide(right)).status).toBe(404); // the link is used
    expect(await row('SELECT channel, otp_challenge_id, session_id FROM diagnosis.quote_approvals WHERE quote_version_id = $1', [sub.quoteVersionId]))
      .toEqual({ channel: 'SIGNED_LINK_OTP', otp_challenge_id: challengeId, session_id: null });
    expect(await row('SELECT used_at IS NOT NULL AS used FROM diagnosis.quote_links WHERE quote_version_id = $1', [sub.quoteVersionId])).toEqual({ used: true });
    expect(h.logs.some((l) => l.includes(token))).toBe(false);
  });
});

// ---------------------------------------------------------------- authorization matrix rows (05 §11) and the off channel

describe('authorization (05 §11 rows) and the ops-recorded channel', () => {
  it('"Approve/reject quote": technicians ✗, other customers ✗; "Complete repair (code)" and "Create/submit diagnosis": customers ✗', async () => {
    const s = await onSite();
    const sub = await diagnose(s);
    const stranger = await customer();
    expect((await asCustomerD(stranger, 'POST', `/v1/customer/quote-versions/${sub.quoteVersionId}/reject`, { contentHash: sub.previewHash, reasonCode: 'OTHER' })).status).toBe(404);
    expect((await asCustomerD(stranger, 'GET', `/v1/customer/jobs/${s.jobId}/quote`, undefined, null)).status).toBe(404);
    expect((await asCustomer(s.c, 'POST', `/v1/technician/visits/${s.visitId}/complete`, { completionCode: '1234', outcome: 'COMPLETE', materialUsage: [] })).status).toBe(404);
    expect((await asCustomerD(s.c, 'PUT', `/v1/technician/diagnoses/${sub.diagnosisId}`, draft())).status).toBe(404);
    expect((await asTechD(s.t, 'GET', `/v1/technician/visits/${s.visitId}/quote`, undefined, null)).body).toMatchObject({ quoteVersionId: sub.quoteVersionId, repairOptions: [] });
  });

  it('the ops-recorded approval channel is disabled by default (D-11)', async () => {
    const admin: Actor = { kind: 'ADMIN', id: newId(), sessionId: newId(), surface: 'ADMIN', permissions: new Map([['support.record_approval', [{ kind: 'CITIES', cityIds: [CITY.id] }]]]) };
    await expect(h.api.diagnosis.recordOpsDecision(admin, { ...admin, id: newId() }, { quoteVersionId: newId(), decision: 'APPROVE', contentHash: '0'.repeat(64),
      callSessionId: newId(), otpChallengeId: newId(), otpCode: '123456' }, randomUUID(), meta())).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  });
});
