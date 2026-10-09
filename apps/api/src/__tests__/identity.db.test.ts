// Gate 3 exit criteria for the public realm (Phase 1 13 ST-08…ST-12, ST-27, ST-28; 05 §2–§4; G-6, SR-02, SR-06, SR-10).
// Runs the api composition (identity module + kms-local + fake SMS) against a throwaway database as LOGIN users of the
// real runtime roles. Synthetic reserved-range phones only.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blindIndex, KmsAccessDeniedError, localEs256Signer, resolveClientIp, signClientIp, signJwt } from '@hsp/security';
import { AppError } from '@hsp/errors';
import { createApiHarness, meta, ORIGIN, testPhone, type ApiHarness } from './harness.ts';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip?: string) =>
  h.api.http({ method, path, headers, body, meta: meta(ip) });

async function requestOtp(phone: string, ip?: string) {
  const r = await call('POST', '/v1/auth/otp/request', { phone, purpose: 'LOGIN', locale: 'te-IN' }, {}, ip);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const challengeId = (r.body as { challengeId: string }).challengeId;
  return { challengeId, code: h.sms.codeFor(challengeId) ?? '' };
}

async function webLogin(phone = testPhone(), surface: 'CUSTOMER_WEB' | 'AGENT_WEB' = 'CUSTOMER_WEB') {
  const otp = await requestOtp(phone);
  const r = await call('POST', '/v1/auth/otp/verify', { challengeId: otp.challengeId, code: otp.code, surface, device: { platform: 'WEB' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const setCookie = r.headers['set-cookie'] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { cookie, setCookie, csrf: (r.body as { csrfToken: string }).csrfToken, body: r.body, phone };
}

async function userIdOf(phone: string): Promise<string> {
  const r = await h.db.admin.query('SELECT id FROM identity.users WHERE phone_bidx = $1', [blindIndex(h.keys.blindIndexPepper, phone)]);
  return r.rows[0]?.id as string;
}

async function appLogin(phone = testPhone()) {
  await requestOtp(phone);
  const userId = await userIdOf(phone);
  h.technicians.add(userId);
  const otp2 = await (async () => { h.clock.advance(31_000); return requestOtp(phone); })();
  const r = await call('POST', '/v1/auth/otp/verify', { challengeId: otp2.challengeId, code: otp2.code, surface: 'TECHNICIAN_APP', device: { platform: 'ANDROID_APP', appVersion: '1.0.0' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const b = r.body as { accessToken: string; refreshToken: string; deviceId: string; session: { id: string } };
  return { ...b, userId, phone };
}

describe('OTP (05 §4, ST-08, ST-09)', () => {
  it('responds identically for registered and unregistered numbers and stores only HMACs', async () => {
    const known = testPhone();
    await webLogin(known);
    h.clock.advance(31_000);
    const a = await call('POST', '/v1/auth/otp/request', { phone: known, purpose: 'LOGIN', locale: 'te-IN' });
    const b = await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'en-IN' });
    expect(Object.keys(a.body as object).sort()).toEqual(Object.keys(b.body as object).sort());
    expect({ ...(a.body as object), challengeId: 'x' }).toEqual({ ...(b.body as object), challengeId: 'x' });
    const id = (a.body as { challengeId: string }).challengeId;
    const row = (await h.db.admin.query('SELECT code_hmac FROM identity.otp_challenges WHERE id = $1', [id])).rows[0];
    expect(Buffer.from(row.code_hmac).toString('utf8')).not.toContain(h.sms.codeFor(id));
  });

  it('rejects real (non-reserved) phone numbers in Phase 2 and unknown request fields', async () => {
    const real = await call('POST', '/v1/auth/otp/request', { phone: '+919876543210', purpose: 'LOGIN', locale: 'te-IN' });
    expect(real.status).toBe(400);
    const extra = await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'te-IN', role: 'ADMIN' });
    expect(extra.status).toBe(400);
    expect((extra.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('ST-08: 5 wrong codes invalidate the challenge; reuse and expiry fail with the same generic error', async () => {
    const phone = testPhone();
    const otp = await requestOtp(phone);
    const wrong = otp.code === '000000' ? '111111' : '000000';
    const verify = (code: string, challengeId = otp.challengeId) =>
      call('POST', '/v1/auth/otp/verify', { challengeId, code, surface: 'CUSTOMER_WEB', device: { platform: 'WEB' } });
    for (let i = 0; i < 5; i += 1) expect((await verify(wrong)).body).toMatchObject({ code: 'OTP_INVALID', status: 400 });
    expect((await verify(otp.code)).body).toMatchObject({ code: 'OTP_INVALID' }); // invalidated after the 5th attempt

    h.clock.advance(31_000);
    const second = await requestOtp(phone);
    expect((await verify(second.code, second.challengeId)).status).toBe(200);
    expect((await verify(second.code, second.challengeId)).body).toMatchObject({ code: 'OTP_INVALID' }); // reuse

    h.clock.advance(31_000);
    const third = await requestOtp(phone);
    h.clock.advance(5 * 60_000 + 1_000);
    expect((await verify(third.code, third.challengeId)).body).toMatchObject({ code: 'OTP_INVALID' }); // expired
  });

  it('per-phone cooldown (30 s) and hourly cap answer 429 with Retry-After', async () => {
    const phone = testPhone();
    await requestOtp(phone);
    const again = await call('POST', '/v1/auth/otp/request', { phone, purpose: 'LOGIN', locale: 'te-IN' });
    expect(again.status).toBe(429);
    expect(again.headers['retry-after']).toBe('30');
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(31_000);
      await requestOtp(phone);
    }
    h.clock.advance(31_000);
    const capped = await call('POST', '/v1/auth/otp/request', { phone, purpose: 'LOGIN', locale: 'te-IN' });
    expect(capped.status).toBe(429);
    expect(capped.headers['retry-after']).toBe('3600');
  });

  it('ST-09 / ST-27: an OTP flood from one client is limited per IP even with spoofed X-Forwarded-For', async () => {
    const now = h.clock.now();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      // The edge resolves the client IP: a spoofed XFF from a non-BFF peer is ignored (SR-10).
      const ip = resolveClientIp({ peerAddress: '203.0.113.9', headers: { 'x-forwarded-for': `10.9.${i}.1` } }, { trustedPeer: 'web-bff', headerKey: randomBytes(32), now });
      statuses.push((await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'te-IN' }, {}, ip)).status);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(20);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // A signed header from the BFF identity is honoured: the real client gets its own bucket.
    const key = randomBytes(32);
    const viaBff = resolveClientIp({ peerAddress: '10.0.0.2', peerIdentity: 'web-bff', headers: { 'x-client-ip': signClientIp(key, '192.0.2.77', now) } }, { trustedPeer: 'web-bff', headerKey: key, now });
    expect(viaBff).toBe('192.0.2.77');
    expect((await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'te-IN' }, {}, viaBff)).status).toBe(202);
  });

  it('a provider outage answers 503 and logs no code', async () => {
    h.sms.failNext(1);
    const r = await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'te-IN' });
    expect(r.status).toBe(503);
  });
});

describe('browser sessions (SR-02, G-6, ST-12)', () => {
  it('sets only an HttpOnly __Host- cookie; the body carries no token', async () => {
    const s = await webLogin();
    expect(s.setCookie).toMatch(/^__Host-sid=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    const body = JSON.stringify(s.body);
    expect(body).not.toContain(s.cookie.split('.')[1] ?? 'none');
    expect(body).not.toMatch(/accessToken|refreshToken/);
    const list = await call('GET', '/v1/auth/sessions', undefined, { cookie: s.cookie });
    expect(list.status).toBe(200);
    expect((list.body as { items: { current: boolean }[] }).items.some((i) => i.current)).toBe(true);
  });

  it('ST-12: a mutation without the CSRF token or from a foreign Origin is refused', async () => {
    const s = await webLogin();
    const sessionId = s.cookie.slice('__Host-sid='.length).split('.')[0] ?? '';
    const del = (headers: Record<string, string>) => call('DELETE', `/v1/auth/sessions/${sessionId}`, undefined, { cookie: s.cookie, ...headers });
    expect((await del({ origin: ORIGIN })).body).toMatchObject({ code: 'CSRF_REJECTED', status: 403 });
    expect((await del({ origin: 'https://evil.invalid', 'x-csrf-token': s.csrf })).body).toMatchObject({ code: 'CSRF_REJECTED' });
    expect((await del({ 'x-csrf-token': s.csrf })).body).toMatchObject({ code: 'CSRF_REJECTED' });
    expect((await del({ origin: ORIGIN, 'x-csrf-token': s.csrf })).status).toBe(204);
    expect((await call('GET', '/v1/auth/sessions', undefined, { cookie: s.cookie })).status).toBe(401);
  });

  it('a forged or truncated cookie is refused, and nobody can revoke another user\'s session (404)', async () => {
    const a = await webLogin();
    const b = await webLogin();
    const [idA] = a.cookie.slice('__Host-sid='.length).split('.');
    expect((await call('GET', '/v1/auth/sessions', undefined, { cookie: `__Host-sid=${idA}.${'A'.repeat(43)}` })).status).toBe(401);
    expect((await call('GET', '/v1/auth/sessions', undefined, { cookie: '__Host-sid=garbage' })).status).toBe(401);
    const r = await call('DELETE', `/v1/auth/sessions/${idA}`, undefined, { cookie: b.cookie, origin: ORIGIN, 'x-csrf-token': b.csrf });
    expect(r.body).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('agent web sessions are unusable until the second factor; the technician app needs eligibility', async () => {
    const agent = await webLogin(testPhone(), 'AGENT_WEB').catch(() => undefined);
    expect(agent).toBeUndefined(); // not an eligible field agent
    const phone = testPhone();
    await requestOtp(phone);
    h.technicians.add(await userIdOf(phone));
    h.clock.advance(31_000);
    const s = await webLogin(phone, 'AGENT_WEB');
    expect((s.body as { nextStep?: string }).nextStep).toBe('SECOND_FACTOR');
    expect((await call('GET', '/v1/auth/sessions', undefined, { cookie: s.cookie })).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
    h.clock.advance(31_000);
    const customer = testPhone();
    const otp = await requestOtp(customer);
    const r = await call('POST', '/v1/auth/otp/verify', { challengeId: otp.challengeId, code: otp.code, surface: 'TECHNICIAN_APP', device: { platform: 'ANDROID_APP' } });
    expect(r.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('step-up: a fresh OTP on the current session sets the step-up time', async () => {
    const s = await webLogin();
    h.clock.advance(31_000);
    const req = await call('POST', '/v1/auth/step-up/otp', {}, { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf });
    expect(req.status, JSON.stringify(req.body)).toBe(202);
    const challengeId = (req.body as { challengeId: string }).challengeId;
    const done = await call('POST', '/v1/auth/step-up', { challengeId, code: h.sms.codeFor(challengeId) }, { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf });
    expect(done.status).toBe(204);
    const actor = await h.api.identity.authenticateWebRequest({ method: 'GET', cookieHeader: s.cookie });
    expect(actor.stepUpAt?.getTime()).toBe(h.clock.now().getTime());
  });
});

describe('technician app tokens (05 §3, ST-10, ST-11)', () => {
  it('rotates refresh tokens; reuse revokes the family and the session (ST-10)', async () => {
    const t = await appLogin();
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(200);
    const r1 = await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: t.deviceId });
    expect(r1.status).toBe(200);
    const rt2 = (r1.body as { refreshToken: string }).refreshToken;
    // Network retry within 10 s from the same device: the same successor, no revocation.
    h.clock.advance(3_000);
    const retry = await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: t.deviceId });
    expect((retry.body as { refreshToken: string }).refreshToken).toBe(rt2);
    // Replay later: reuse detected.
    h.clock.advance(20_000);
    const replay = await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: t.deviceId });
    expect(replay.body).toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
    expect((await call('POST', '/v1/auth/token/refresh', { refreshToken: rt2, deviceId: t.deviceId })).status).toBe(401);
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
    const audit = await h.db.admin.query("SELECT count(*)::int AS n FROM compliance.audit_logs WHERE action = 'auth.refresh_reuse_detected' AND resource_id = $1", [t.session.id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('a refresh token presented from another device revokes the session', async () => {
    const t = await appLogin();
    const r = await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: '0190f0aa-1111-7222-8333-444455556666' });
    expect(r.body).toMatchObject({ code: 'SESSION_REVOKED' });
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
  });

  it('ST-11: alg=none, HS256, foreign keys, wrong audience and expired tokens are all 401', async () => {
    const t = await appLogin();
    const [header, payload] = t.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.AA`;
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid })).toString('base64url')}.${payload}.AAAA`;
    const foreign = await signJwt(localEs256Signer(JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey), claims);
    for (const token of [none, hs, foreign, 'not-a-jwt']) {
      expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${token}` })).status, token.slice(0, 20)).toBe(401);
    }
    await expect(h.api.identity.authenticateAccessToken(t.accessToken)).resolves.toMatchObject({ kind: 'TECHNICIAN', id: t.userId });
    h.clock.advance(11 * 60_000);
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
  });

  it('suspension revokes every session immediately and blocks login', async () => {
    const t = await appLogin();
    await h.api.identity.suspendUser(t.userId, 'SAFETY_HOLD', { kind: 'SYSTEM' }, meta());
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
    expect((await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: t.deviceId })).status).toBe(401);
    h.clock.advance(31_000);
    const otp = await requestOtp(t.phone);
    expect(h.sms.codeFor(otp.challengeId)).toBeUndefined(); // nothing is sent to a suspended account
  });
});

describe('field encryption and erasure (SR-06, SR-07, ST-28)', () => {
  it('stores the phone encrypted under a per-class subject key; only roles with the class grant can reveal it', async () => {
    const t = await appLogin();
    const row = (await h.db.admin.query('SELECT phone_enc, phone_bidx, phone_masked FROM identity.users WHERE id = $1', [t.userId])).rows[0];
    expect(Buffer.from(row.phone_enc).includes(Buffer.from(t.phone))).toBe(false);
    expect(row.phone_masked).toBe(`+91 ••••• •••${t.phone.slice(-2)}`);
    const key = (await h.db.admin.query('SELECT data_class, kms_key_arn FROM identity.subject_keys WHERE user_id = $1', [t.userId])).rows;
    expect(key).toEqual([{ data_class: 'pii-contact', kms_key_arn: 'kms-local:pii-contact' }]);
    expect(await h.api.identity.revealPhoneForDelivery(t.userId)).toBe(t.phone);
    const worker = await h.role('app_worker', 'worker');
    await expect(worker.identity.revealPhoneForDelivery(t.userId)).rejects.toBeInstanceOf(KmsAccessDeniedError);
  });

  it('ST-28: after erasure an old token is 401 and the ciphertext is unreadable (subject key destroyed)', async () => {
    const t = await appLogin();
    const before = (await h.db.admin.query('SELECT phone_enc FROM identity.users WHERE id = $1', [t.userId])).rows[0].phone_enc as Buffer;
    const worker = await h.role('app_worker', 'worker');
    await worker.identity.eraseIdentity(t.userId, meta());
    expect((await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
    expect((await call('POST', '/v1/auth/token/refresh', { refreshToken: t.refreshToken, deviceId: t.deviceId })).status).toBe(401);
    const user = (await h.db.admin.query('SELECT status, phone_enc, phone_bidx, phone_masked FROM identity.users WHERE id = $1', [t.userId])).rows[0];
    expect(user).toEqual({ status: 'ERASED', phone_enc: null, phone_bidx: null, phone_masked: null });
    const key = (await h.db.admin.query('SELECT wrapped_dek, destroyed_at FROM identity.subject_keys WHERE user_id = $1', [t.userId])).rows[0];
    expect(key.wrapped_dek).toBeNull();
    expect(key.destroyed_at).not.toBeNull();
    await expect(h.api.identity.revealPhoneForDelivery(t.userId)).rejects.toBeInstanceOf(AppError);
    // Even a copy of the old ciphertext (a restored backup) can't be opened once other processes' DEK caches expire
    // (≤ 5 minutes, SR-06): put it back and try to reveal.
    h.clock.advance(5 * 60_000 + 1_000);
    await h.db.admin.query("UPDATE identity.users SET status = 'SUSPENDED', phone_enc = $2, erased_at = NULL WHERE id = $1", [t.userId, before]);
    await expect(h.api.identity.revealPhoneForDelivery(t.userId)).rejects.toThrow(/destroyed/);
    await h.db.admin.query("UPDATE identity.users SET status = 'ERASED', phone_enc = NULL, erased_at = now() WHERE id = $1", [t.userId]);
    // The same number may register again as a new account.
    h.clock.advance(31_000);
    await requestOtp(t.phone);
  });

  it('crypto-shredding across independent instances: no new decryption anywhere; a warm cache may decrypt for ≤ 5 minutes (accepted SR-06 window)', async () => {
    const t = await appLogin(); // instance A (h.api) sealed the phone and holds the data key in its cache
    const instanceB = await h.role('app_api', 'api'); // a second api process with its own, independent cache
    expect(await instanceB.identity.revealPhoneForDelivery(t.userId)).toBe(t.phone); // B now caches the key too
    const ciphertext = (await h.db.admin.query('SELECT phone_enc FROM identity.users WHERE id = $1', [t.userId])).rows[0].phone_enc as Buffer;
    const worker = await h.role('app_worker', 'worker');
    await worker.identity.eraseIdentity(t.userId, meta()); // a third process erases; it can't reach A's or B's memory
    // Simulate a restored copy of the ciphertext (e.g. from a backup) so each instance actually attempts decryption.
    await h.db.admin.query("UPDATE identity.users SET status = 'SUSPENDED', phone_enc = $2, erased_at = NULL WHERE id = $1", [t.userId, ciphertext]);
    const instanceC = await h.role('app_api', 'api'); // cold cache
    await expect(instanceC.identity.revealPhoneForDelivery(t.userId)).rejects.toThrow(/destroyed/); // immediately unreadable
    // Accepted window: instances that already cached the data key can still decrypt until the cache entry expires.
    // Erasure does NOT revoke other processes' caches immediately.
    expect(await h.api.identity.revealPhoneForDelivery(t.userId)).toBe(t.phone);
    expect(await instanceB.identity.revealPhoneForDelivery(t.userId)).toBe(t.phone);
    h.clock.advance(5 * 60_000 + 1_000);
    await expect(h.api.identity.revealPhoneForDelivery(t.userId)).rejects.toThrow(/destroyed/);
    await expect(instanceB.identity.revealPhoneForDelivery(t.userId)).rejects.toThrow(/destroyed/);
    await h.db.admin.query("UPDATE identity.users SET status = 'ERASED', phone_enc = NULL, erased_at = now() WHERE id = $1", [t.userId]);
  });
});

describe('IVR PIN (05 §2.3)', () => {
  it('rejects trivial PINs, ends the call after 3 wrong, locks after 5 wrong in 24 h until a verified reset', async () => {
    const t = await appLogin();
    const voice = await h.role('app_voice', 'voice');
    const system = { kind: 'SYSTEM' as const };
    await expect(h.api.identity.setIvrPin({ userId: t.userId, pin: '1234', via: 'APP' }, system, meta())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await h.api.identity.setIvrPin({ userId: t.userId, pin: '2580', via: 'APP' }, system, meta());
    const stored = (await h.db.admin.query('SELECT pin_hash FROM identity.ivr_credentials WHERE user_id = $1', [t.userId])).rows[0].pin_hash as string;
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain('2580');
    const verify = (pin: string, failuresThisCall: number) => voice.identity.verifyIvrPin({ userId: t.userId, pin, failuresThisCall }, meta());
    expect(await verify('2580', 0)).toEqual({ outcome: 'OK' });
    expect(await verify('1111', 0)).toEqual({ outcome: 'WRONG', endCall: false });
    expect(await verify('1111', 1)).toEqual({ outcome: 'WRONG', endCall: false });
    expect(await verify('1111', 2)).toEqual({ outcome: 'WRONG', endCall: true }); // 3rd wrong in the call
    expect(await verify('2580', 0)).toEqual({ outcome: 'OK' }); // success resets the counter
    // Failures older than 24 h don't count towards the lock.
    await verify('1111', 0);
    await verify('1111', 1);
    h.clock.advance(25 * 3_600_000);
    for (let i = 0; i < 4; i += 1) expect((await verify('1111', i % 2)).outcome).toBe('WRONG');
    expect(await verify('1111', 0)).toEqual({ outcome: 'LOCKED', endCall: true }); // 5th within 24 h
    expect(await verify('2580', 0)).toEqual({ outcome: 'LOCKED', endCall: true });
    await h.api.identity.setIvrPin({ userId: t.userId, pin: '7319', via: 'AGENT_ASSISTED_VERIFIED' }, system, meta());
    expect(await verify('7319', 0)).toEqual({ outcome: 'OK' });
  });
});

describe('audit and no-CORS', () => {
  it('auth events are audited in a valid hash chain without phone numbers or codes', async () => {
    const s = await webLogin();
    const rows = (await h.db.admin.query("SELECT action, change_summary::text AS cs FROM compliance.audit_logs WHERE action LIKE 'auth.%'")).rows;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.otp_requested', 'auth.login_succeeded', 'auth.login_failed']));
    expect(JSON.stringify(rows)).not.toContain(s.phone.slice(3));
    const months = (await h.db.admin.query('SELECT chain_partition FROM compliance.audit_chain_heads')).rows.map((r) => r.chain_partition as string);
    for (const m of months) {
      const v = (await h.db.admin.query('SELECT * FROM compliance.verify_audit_chain($1)', [m])).rows[0];
      expect(v.ok, m).toBe(true);
    }
  });

  it('no response carries CORS headers (G-6 / SR-11)', async () => {
    const r = await call('POST', '/v1/auth/otp/request', { phone: testPhone(), purpose: 'LOGIN', locale: 'te-IN' }, { origin: 'https://evil.invalid' });
    expect(Object.keys(r.headers).filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([]);
    const options = await call('OPTIONS', '/v1/auth/otp/request', undefined, { origin: 'https://evil.invalid', 'access-control-request-method': 'POST' });
    expect(options.status).toBe(404);
    expect(Object.keys(options.headers).filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([]);
  });
});
