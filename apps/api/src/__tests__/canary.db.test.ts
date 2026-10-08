// Gate 3 exit criterion "Canary-PII scan: 0 hits" (Phase 1 11 §2.1, 13 ST-30): every identity flow runs with a canary
// phone number; afterwards all captured log lines, all audit rows, all error bodies and all success bodies are scanned for
// the canary and for every secret the flows produced (OTP codes, refresh tokens, cookie secrets, PINs, access tokens).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY, findCanaries } from '@hsp/testing';
import { createApiHarness, meta, ORIGIN, type ApiHarness } from './harness.ts';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('canary-PII scan', () => {
  it('finds no canary value or secret in logs, audit rows or responses', async () => {
    const secrets: string[] = [];
    const errorBodies: string[] = [];
    const okBodies: string[] = [];
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await h.api.http({ method, path, body, headers, meta: meta() });
      (r.status >= 400 ? errorBodies : okBodies).push(JSON.stringify(r.body ?? null));
      return r;
    };

    // Web login with a wrong code first, then the right one.
    const otp1 = await call('POST', '/v1/auth/otp/request', { phone: CANARY.phone, purpose: 'LOGIN', locale: 'te-IN' });
    const ch1 = (otp1.body as { challengeId: string }).challengeId;
    const code1 = h.sms.codeFor(ch1) ?? '';
    secrets.push(code1);
    await call('POST', '/v1/auth/otp/verify', { challengeId: ch1, code: code1 === '999999' ? '999998' : '999999', surface: 'CUSTOMER_WEB', device: { platform: 'WEB' } });
    const web = await call('POST', '/v1/auth/otp/verify', { challengeId: ch1, code: code1, surface: 'CUSTOMER_WEB', device: { platform: 'WEB' } });
    const cookie = (web.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    secrets.push(cookie.split('.')[1] ?? 'missing-cookie-secret');
    const csrf = (web.body as { csrfToken: string }).csrfToken;
    await call('DELETE', '/v1/auth/sessions/0190f0aa-1111-7222-8333-444455556666', undefined, { cookie, origin: ORIGIN }); // CSRF failure

    // Step-up.
    h.clock.advance(31_000);
    const su = await call('POST', '/v1/auth/step-up/otp', {}, { cookie, origin: ORIGIN, 'x-csrf-token': csrf });
    const suId = (su.body as { challengeId: string }).challengeId;
    secrets.push(h.sms.codeFor(suId) ?? '');
    await call('POST', '/v1/auth/step-up', { challengeId: suId, code: h.sms.codeFor(suId) }, { cookie, origin: ORIGIN, 'x-csrf-token': csrf });

    // Technician app login, refresh, reuse.
    const userId = (await h.db.admin.query("SELECT id FROM identity.users WHERE status = 'ACTIVE'")).rows[0].id as string;
    h.technicians.add(userId);
    h.clock.advance(31_000);
    const otp2 = await call('POST', '/v1/auth/otp/request', { phone: CANARY.phone, purpose: 'LOGIN', locale: 'te-IN' });
    const ch2 = (otp2.body as { challengeId: string }).challengeId;
    secrets.push(h.sms.codeFor(ch2) ?? '');
    const app = await call('POST', '/v1/auth/otp/verify', { challengeId: ch2, code: h.sms.codeFor(ch2), surface: 'TECHNICIAN_APP', device: { platform: 'ANDROID_APP' } });
    const tokens = app.body as { accessToken: string; refreshToken: string; deviceId: string };
    secrets.push(tokens.refreshToken, tokens.accessToken);
    const r1 = await call('POST', '/v1/auth/token/refresh', { refreshToken: tokens.refreshToken, deviceId: tokens.deviceId });
    secrets.push((r1.body as { refreshToken: string }).refreshToken);
    h.clock.advance(20_000);
    await call('POST', '/v1/auth/token/refresh', { refreshToken: tokens.refreshToken, deviceId: tokens.deviceId }); // reuse

    // IVR PIN set / wrong / right.
    await h.api.identity.setIvrPin({ userId, pin: '7319', via: 'APP' }, { kind: 'SYSTEM' }, meta());
    secrets.push('7319');
    const voice = await h.role('app_voice', 'voice');
    await voice.identity.verifyIvrPin({ userId, pin: '4826', failuresThisCall: 0 }, meta());
    await voice.identity.verifyIvrPin({ userId, pin: '7319', failuresThisCall: 1 }, meta());

    const audit = (await h.db.admin.query('SELECT row_to_json(a)::text AS j FROM compliance.audit_logs a')).rows.map((r) => r.j as string);
    expect(h.logs.length).toBeGreaterThan(5);
    expect(audit.length).toBeGreaterThan(8);
    expect(secrets.every((s) => s.length >= 4)).toBe(true);

    // PIN '7319' and 6-digit codes are short: scan them only where any digits are suspicious (logs, audit, errors).
    const logHits = findCanaries(h.logs, secrets);
    const auditHits = findCanaries(audit, secrets);
    const errorHits = findCanaries(errorBodies, secrets);
    const okHits = findCanaries(okBodies); // success bodies legitimately contain the caller's own tokens; PII only
    expect({ logHits, auditHits, errorHits, okHits }).toEqual({ logHits: [], auditHits: [], errorHits: [], okHits: [] });
    expect(okBodies.join('\n')).not.toContain(CANARY.phoneDigits);
  });
});
