// Gate 6 (ADR-027): diagnosis / quote rules (state machines, content hash, repair options Q-A, SR-05 link tokens and
// preview agents), the authorization policies (05 §11 rows "Create/submit diagnosis", "Approve/reject quote", "Edit
// approved quote"), SQL ownership (B2) and the TCP-2 coupling point (B4).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson, UnitOfWork } from '@hsp/db';
import { AUTHZ_MATRIX, PolicyRegistry, type Actor } from '@hsp/policy';
import {
  canMove, DIAGNOSIS_SQL, DiagnosisService, DIAGNOSIS_TIMER_TASKS, DIAGNOSIS_TRANSITIONS, FIXTURE_DIAGNOSIS_POLICY, isLinkPreviewAgent, linkTokenHash, newLinkToken,
  QUOTE_VERSION_TRANSITIONS, quoteContentHash, registerDiagnosisPolicies, repairOptions, type HashedLine,
} from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));
const r = new PolicyRegistry();
registerDiagnosisPolicies(r);
const ctx = { now: new Date() };
const customer: Actor = { kind: 'CUSTOMER', id: 'c1', sessionId: 's1', surface: 'CUSTOMER_WEB' };
const technician: Actor = { kind: 'TECHNICIAN', id: 't1', sessionId: 's2', surface: 'TECHNICIAN_APP' };
const admin = (perms: Record<string, string[]>): Actor => ({ kind: 'ADMIN', id: 'a1', sessionId: 's3',
  permissions: new Map(Object.entries(perms).map(([p, s]) => [p, [{ kind: 'CITIES' as const, cityIds: s }]])) });

const line = (n: number, amount: number): HashedLine => ({ lineNo: n, itemType: 'LABOUR', repairItemId: null, materialId: null, labelKey: 'quote.line.repair_item',
  labelParams: { code: 'REP-X' }, qty: '1.000', unitPricePaise: amount, amountPaise: amount });
const totals = (t: number) => ({ itemsTotalPaise: t, discountPaise: 0, visitFeeCreditPaise: 0, taxPaise: 0, totalPayablePaise: t });

describe('state machines (06 §6–§7, D11)', () => {
  it('a version is SUPERSEDED only after APPROVED; a PRESENTED version replaced before a decision is WITHDRAWN', () => {
    expect(canMove(QUOTE_VERSION_TRANSITIONS, 'PRESENTED', 'SUPERSEDED')).toBe(false);
    expect(canMove(QUOTE_VERSION_TRANSITIONS, 'APPROVED', 'SUPERSEDED')).toBe(true);
    expect(canMove(QUOTE_VERSION_TRANSITIONS, 'PRESENTED', 'WITHDRAWN')).toBe(true);
    expect(canMove(QUOTE_VERSION_TRANSITIONS, 'APPROVED', 'PRESENTED')).toBe(false);
    for (const terminal of ['REJECTED', 'EXPIRED', 'WITHDRAWN', 'SUPERSEDED']) expect(QUOTE_VERSION_TRANSITIONS[terminal]).toEqual([]);
    expect(canMove(DIAGNOSIS_TRANSITIONS, 'SUBMITTED', 'DRAFT')).toBe(false);
    expect(canMove(DIAGNOSIS_TRANSITIONS, 'DRAFT', 'SUBMITTED')).toBe(true);
  });

  it('a random walk over the version table never leaves it and only APPROVED reaches SUPERSEDED', () => {
    fc.assert(fc.property(fc.array(fc.nat(), { maxLength: 20 }), (picks) => {
      let state = 'DRAFT';
      let wasApproved = false;
      for (const p of picks) {
        const next = QUOTE_VERSION_TRANSITIONS[state] ?? [];
        if (next.length === 0) return;
        const to = next[p % next.length] ?? state;
        if (to === 'SUPERSEDED') expect(wasApproved && state === 'APPROVED').toBe(true);
        if (to === 'APPROVED') wasApproved = true;
        state = to;
      }
    }), { numRuns: 500 });
  });
});

describe('content hash (03 §11, INV-06)', () => {
  it('is deterministic and changes with any line or total', () => {
    const a = quoteContentHash([line(1, 100), line(2, 200)], totals(300));
    expect(quoteContentHash([line(1, 100), line(2, 200)], totals(300)).equals(a)).toBe(true);
    expect(a).toHaveLength(32);
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), (x, y) => {
      fc.pre(x !== y);
      expect(quoteContentHash([line(1, x)], totals(x)).equals(quoteContentHash([line(1, y)], totals(x)))).toBe(false);
      expect(quoteContentHash([line(1, x)], totals(x)).equals(quoteContentHash([line(1, x)], totals(y)))).toBe(false);
    }), { numRuns: 300 });
    expect(quoteContentHash([{ ...line(1, 100), labelKey: 'quote.line.other' }], totals(100)).equals(quoteContentHash([line(1, 100)], totals(100)))).toBe(false);
  });
});

describe('repair options (02 §4, Q-A)', () => {
  const base = { changeOrder: false, diagnosingTechnicianQualified: true, sameVisitAllowedByRule: true, sameVisitFeasible: true, materialAvailableNow: true,
    visitStillInProgress: true, msSincePresentation: 0, sameVisitMaxWaitMs: FIXTURE_DIAGNOSIS_POLICY.sameVisitMaxWaitMs };
  const available = (f: Partial<typeof base>) => repairOptions({ ...base, ...f }).filter((o) => o.available).map((o) => o.option);

  it('qualified diagnosing technician: same visit (when every guard holds), same technician later, a specialist', () => {
    expect(available({})).toEqual(['SAME_VISIT', 'SAME_TECHNICIAN', 'RECOMMENDED_SPECIALIST']);
    for (const f of [{ sameVisitAllowedByRule: false }, { materialAvailableNow: false }, { sameVisitFeasible: false }, { visitStillInProgress: false },
      { msSincePresentation: base.sameVisitMaxWaitMs + 1 }]) {
      expect(available(f), JSON.stringify(f)).toEqual(['SAME_TECHNICIAN', 'RECOMMENDED_SPECIALIST']);
    }
  });

  it('not qualified: the recommended specialist is the only path, with the technical reason', () => {
    const opts = repairOptions({ ...base, diagnosingTechnicianQualified: false });
    expect(opts.filter((o) => o.available).map((o) => o.option)).toEqual(['RECOMMENDED_SPECIALIST']);
    expect(opts.find((o) => o.option === 'SAME_TECHNICIAN')?.reasonKey).toBe('quote.option.reason.technician_not_qualified');
    expect(repairOptions({ ...base, changeOrder: true })).toEqual([]);
  });
});

describe('signed links (SR-05)', () => {
  it('256-bit base64url tokens; only a hash is stored; preview agents are recognised', () => {
    const { token, hash } = newLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(linkTokenHash(token).equals(hash)).toBe(true);
    expect(newLinkToken().token).not.toBe(token);
    for (const ua of ['WhatsApp/2.23', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'TelegramBot (like TwitterBot)']) expect(isLinkPreviewAgent(ua)).toBe(true);
    expect(isLinkPreviewAgent('Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile')).toBe(false);
  });
});

describe('diagnosis policies (05 §11)', () => {
  it('technicians write diagnoses only as the ACTIVE assignee, from the app; others get 404', () => {
    expect(r.can(technician, 'diagnosis.diagnosis.write', { isAssignee: true }, ctx).allow).toBe(true);
    expect(r.can(technician, 'diagnosis.diagnosis.write', { isAssignee: false }, ctx)).toMatchObject({ allow: false, status: 404 });
    expect(r.can({ ...technician, surface: 'TECHNICIAN_IVR' }, 'diagnosis.diagnosis.write', { isAssignee: true }, ctx).allow).toBe(false);
    expect(r.can(customer, 'diagnosis.diagnosis.write', { isAssignee: true }, ctx).allow).toBe(false);
  });

  it('only the job owner decides, from the own session (INV-08); technicians and ops cannot decide', () => {
    expect(r.can(customer, 'diagnosis.quote.decide', { ownerUserId: 'c1' }, ctx).allow).toBe(true);
    expect(r.can(customer, 'diagnosis.quote.decide', { ownerUserId: 'c2' }, ctx)).toMatchObject({ allow: false, status: 404 });
    expect(r.can(technician, 'diagnosis.quote.decide', { ownerUserId: 't1' }, ctx).allow).toBe(false);
    expect(r.can(admin({ 'support.record_approval': ['k1'] }), 'diagnosis.quote.decide', { ownerUserId: 'a1' }, ctx).allow).toBe(false);
  });

  it('ops capture needs support.capture_diagnosis for the city; recorded decisions support.record_approval', () => {
    expect(r.can(admin({ 'support.capture_diagnosis': ['k1'] }), 'diagnosis.ops_capture', { cityId: 'k1' }, ctx).allow).toBe(true);
    expect(r.can(admin({ 'support.capture_diagnosis': ['k1'] }), 'diagnosis.ops_capture', { cityId: 'k2' }, ctx).allow).toBe(false);
    expect(r.can(admin({ 'dispatch.assign': ['k1'] }), 'diagnosis.ops_capture', { cityId: 'k1' }, ctx).allow).toBe(false);
    expect(r.can(admin({ 'support.record_approval': ['k1'] }), 'diagnosis.quote.record_decision', { cityId: 'k1' }, ctx).allow).toBe(true);
    expect(r.can(admin({ 'support.capture_diagnosis': ['k1'] }), 'diagnosis.quote.record_decision', { cityId: 'k1' }, ctx).allow).toBe(false);
  });

  it('"Edit approved quote" is ❌ for every column, and no policy for it exists', () => {
    const row = AUTHZ_MATRIX.find((x) => x.capability === 'Edit approved quote');
    expect(Object.values(row?.cells ?? {}).every((c) => c.startsWith('❌'))).toBe(true);
    for (const action of ['diagnosis.quote.edit', 'diagnosis.quote.update', 'diagnosis.quote_item.update']) expect(r.has(action)).toBe(false);
  });
});

describe('architecture', () => {
  it('B2: diagnosis SQL touches only diagnosis and platform', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(DIAGNOSIS_SQL)) expect(() => assertModuleOwnsSql('diagnosis', sql, ownership), name).not.toThrow();
  });

  it('B4: TCP-2 (jobs → diagnosis.recordMaterialUsage) is an approved coupling point; diagnosis may not join a jobs unit of work otherwise', () => {
    const uow = new UnitOfWork('jobs', spec.transactionalCouplingPoints);
    expect(() => uow.join('jobs', 'diagnosis', 'recordMaterialUsage')).not.toThrow();
    expect(() => uow.join('jobs', 'diagnosis', 'approveQuoteVersion')).toThrow();
    expect(() => new UnitOfWork('diagnosis', spec.transactionalCouplingPoints).join('diagnosis', 'jobs', 'createRepairOrder')).toThrow();
  });

  it('timer task names fit the platform.schedule_timer pattern', () => {
    for (const t of Object.values(DIAGNOSIS_TIMER_TASKS)) expect(t).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/);
  });
});

describe('environment gates (ADR-027 #3, D-11)', () => {
  const unreachable = new Proxy({}, { get: () => { throw new Error('dependency must not be reached'); } });
  const service = (appEnv: 'dev' | 'staging' | 'test', opsRecordedApprovalEnabled = false) => new DiagnosisService({
    pool: unreachable as never, clock: { now: () => new Date() }, logger: unreachable as never, policies: r, appEnv, requestHashKey: Buffer.alloc(32),
    policy: { ...FIXTURE_DIAGNOSIS_POLICY, opsRecordedApprovalEnabled }, jobs: unreachable as never, catalog: unreachable as never, pricing: unreachable as never,
    skills: unreachable as never, otp: unreachable as never, links: unreachable as never, callEvidence: unreachable as never,
  });
  const capturer = admin({ 'support.capture_diagnosis': ['k1'] });
  const meta = { requestId: '00000000-0000-4000-8000-000000000001', clientIp: '198.51.100.1' };

  it('ops-desk capture is refused outside local / test before anything else runs (telephony is Gate 10)', async () => {
    for (const env of ['dev', 'staging'] as const) {
      await expect(service(env).opsStartDiagnosis(capturer, 'v', { kind: 'INITIAL', callSessionId: 'c' }, 'k', meta)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      await expect(service(env).opsSubmitDiagnosis(capturer, 'd', { expectedVersion: 0 }, 'k', meta)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    }
  });

  it('the ops-recorded approval channel is off unless the policy enables it (D-11)', async () => {
    await expect(service('test').recordOpsDecision(capturer, capturer, { quoteVersionId: 'x', decision: 'APPROVE', contentHash: '0', callSessionId: 'c',
      otpChallengeId: 'o', otpCode: '1' }, 'k', meta)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(FIXTURE_DIAGNOSIS_POLICY.opsRecordedApprovalEnabled).toBe(false);
  });
});
