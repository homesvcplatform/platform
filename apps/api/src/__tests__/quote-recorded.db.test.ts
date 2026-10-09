// Gate 6 exit criterion "separation-of-duties tests (G-9)" and "ops-recorded channel implemented but flag-off": with the
// accessibility fallback switched ON for this test only (it is OFF by default, D-11 pending), an ops-desk-captured
// diagnosis (bridged call, fake telephony, ADR-027 #3) is decided on a recorded call: recorder ≠ verifier ≠ diagnosis
// capturer, the verifier freshly stepped up, the customer read back the code sent to their registered number, and the
// total within the cap. Throwaway database, synthetic data, fixture prices (NOT FINAL).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { FIXTURE_DIAGNOSIS_POLICY } from '@hsp/module-diagnosis';
import type { Actor } from '@hsp/policy';
import { kurnool, loadSyntheticSeed } from '@hsp/testing';
import { draft, gate6Kit, MAT_THERMO, REP_THERMO, type Gate6Kit } from './gate6-kit.ts';
import { createApiHarness, meta, type ApiHarness } from './harness.ts';

let h: ApiHarness;
let apiPool: pg.Pool;
let k: Gate6Kit;
const { CITY } = kurnool;

beforeAll(async () => {
  h = await createApiHarness({ diagnosisPolicy: { ...FIXTURE_DIAGNOSIS_POLICY, opsRecordedApprovalEnabled: true } });
  await loadSyntheticSeed(h.db.migrator);
  apiPool = new pg.Pool({ connectionString: await h.db.loginFor('app_api'), max: 3 });
  k = gate6Kit(h, apiPool);
});
afterAll(async () => {
  await apiPool?.end();
  await h?.close();
});

const admin = (perms: string[], stepUp = false): Actor => ({ kind: 'ADMIN', id: newId(), sessionId: newId(), surface: 'ADMIN',
  permissions: new Map(perms.map((p) => [p, [{ kind: 'CITIES' as const, cityIds: [CITY.id] }]])), ...(stepUp ? { stepUpAt: h.clock.now() } : {}) });

/** An ops-captured, presented quote on an on-site visit (capture on a bridged call with the technician). */
async function opsCapturedQuote(capturer: Actor, items: unknown[]) {
  const s = await k.onSite();
  const bridged = newId();
  await expect(h.api.diagnosis.opsStartDiagnosis(capturer, s.visitId, { kind: 'INITIAL', callSessionId: bridged }, randomUUID(), meta()))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // no such bridged call
  h.calls.add(bridged);
  const started = await h.api.diagnosis.opsStartDiagnosis(capturer, s.visitId, { kind: 'INITIAL', callSessionId: bridged }, randomUUID(), meta());
  const updated = await h.api.diagnosis.opsUpdateDraft(capturer, started.diagnosisId, { ...draft({ items }), expectedVersion: started.version } as never, randomUUID(), meta());
  const preview = await h.api.diagnosis.opsPreviewQuote(capturer, started.diagnosisId);
  const sub = await h.api.diagnosis.opsSubmitDiagnosis(capturer, started.diagnosisId, { expectedVersion: updated.version, previewHash: preview.previewHash }, randomUUID(), meta());
  expect(await k.row('SELECT captured_by_actor_type, captured_by_actor_id, technician_user_id FROM diagnosis.diagnoses WHERE id = $1', [started.diagnosisId]))
    .toEqual({ captured_by_actor_type: 'OPS_AGENT', captured_by_actor_id: capturer.id, technician_user_id: s.t.userId });
  return { ...s, versionId: String(sub.quoteVersionId), hash: preview.previewHash, total: Number(sub.totalPayablePaise) };
}

async function readBack(customerUserId: string) {
  h.clock.advance(31_000);
  const { challengeId } = await h.api.identity.requestQuoteApprovalOtp(customerUserId, meta());
  return { otpChallengeId: challengeId, otpCode: h.sms.codeFor(challengeId) ?? '' };
}

describe('ops-desk capture (ADR-027 #3) and the ops-recorded channel (INV-08, G-9)', () => {
  it('capture needs support.capture_diagnosis for the city and a bridged call; only the capturer edits the draft', async () => {
    const s = await k.onSite();
    h.calls.add('00000000-0000-4000-8000-0000000000aa');
    await expect(h.api.diagnosis.opsStartDiagnosis(admin(['support.record_approval']), s.visitId,
      { kind: 'INITIAL', callSessionId: '00000000-0000-4000-8000-0000000000aa' }, randomUUID(), meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const capturer = admin(['support.capture_diagnosis']);
    const started = await h.api.diagnosis.opsStartDiagnosis(capturer, s.visitId, { kind: 'INITIAL', callSessionId: '00000000-0000-4000-8000-0000000000aa' },
      randomUUID(), meta());
    await expect(h.api.diagnosis.opsUpdateDraft(admin(['support.capture_diagnosis']), started.diagnosisId, { ...draft(), expectedVersion: 0 } as never,
      randomUUID(), meta())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await k.row("SELECT count(*)::int AS n FROM compliance.audit_logs WHERE resource_id = $1 AND action = 'diagnosis.draft_created' AND actor_type = 'ADMIN'",
      [started.diagnosisId])).toEqual({ n: 1 });
  });

  it('G-9: recorder ≠ verifier ≠ diagnosis capturer; the verifier steps up; the customer reads back the code; within the cap', async () => {
    const capturer = admin(['support.capture_diagnosis', 'support.record_approval'], true);
    const q = await opsCapturedQuote(capturer, [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }]);
    expect(q.total).toBeLessThanOrEqual(FIXTURE_DIAGNOSIS_POLICY.opsRecordedApprovalMaxPaise);
    const recorder = admin(['support.record_approval']);
    const verifier = admin(['support.record_approval'], true);
    const call = newId();
    h.calls.add(call);
    // The read-back code is only requested where the check reaches it (per-phone OTP limits).
    const decide = async (rec: Actor, ver: Actor, over: Record<string, unknown> = {}, realCode = false) => h.api.diagnosis.recordOpsDecision(rec, ver, {
      quoteVersionId: q.versionId, decision: 'APPROVE', contentHash: q.hash, repairPreference: 'RECOMMENDED_SPECIALIST', allowFallback: true, callSessionId: call,
      ...(realCode ? await readBack(q.c.userId) : { otpChallengeId: newId(), otpCode: '000000' }), ...over,
    } as never, randomUUID(), meta());
    await expect(decide(capturer, verifier)).rejects.toMatchObject({ code: 'FORBIDDEN' }); // capturer records
    await expect(decide(recorder, capturer)).rejects.toMatchObject({ code: 'FORBIDDEN' }); // capturer verifies
    await expect(decide(recorder, recorder)).rejects.toMatchObject({ code: 'FORBIDDEN' }); // one person both
    await expect(decide(recorder, admin(['support.record_approval']))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(decide(recorder, admin(['support.capture_diagnosis'], true))).rejects.toMatchObject({ code: 'FORBIDDEN' }); // verifier lacks the permission
    await expect(decide(recorder, verifier, { callSessionId: newId() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // no recorded call
    await expect(decide(recorder, verifier)).rejects.toMatchObject({ code: 'OTP_INVALID' }); // no / wrong read-back code
    const ok = await decide(recorder, verifier, {}, true);
    expect(ok).toMatchObject({ status: 'APPROVED' });
    expect(await k.row(`SELECT channel, ops_recorder_admin_id, ops_verifier_admin_id, diagnosis_capturer_admin_id, call_session_id, otp_challenge_id IS NOT NULL AS otp
      FROM diagnosis.quote_approvals WHERE quote_version_id = $1`, [q.versionId])).toEqual({ channel: 'OPS_RECORDED_CALL', ops_recorder_admin_id: recorder.id,
      ops_verifier_admin_id: verifier.id, diagnosis_capturer_admin_id: capturer.id, call_session_id: call, otp: true });
  });

  it('a total above the recorded-approval cap is refused (INV-08: ≤ ₹1,000 provisional)', async () => {
    const capturer = admin(['support.capture_diagnosis']);
    const q = await opsCapturedQuote(capturer, [{ type: 'REPAIR_ITEM', repairItemId: REP_THERMO, qty: 1 }, { type: 'MATERIAL', materialId: MAT_THERMO, qty: 1 }]);
    expect(q.total).toBeGreaterThan(FIXTURE_DIAGNOSIS_POLICY.opsRecordedApprovalMaxPaise);
    const call = newId();
    h.calls.add(call);
    await expect(h.api.diagnosis.recordOpsDecision(admin(['support.record_approval']), admin(['support.record_approval'], true), {
      quoteVersionId: q.versionId, decision: 'APPROVE', contentHash: q.hash, repairPreference: 'RECOMMENDED_SPECIALIST', allowFallback: true, callSessionId: call,
      otpChallengeId: newId(), otpCode: '123456' }, randomUUID(), meta())).rejects.toMatchObject({ code: 'VALIDATION_FAILED',
      fields: [{ code: 'ABOVE_RECORDED_APPROVAL_CAP' }] });
  });
});
