// Gate 3 unit tests for @hsp/security: hashing, codes, Argon2id, ES256 JWT (ST-11), request trust (ST-12 / ST-27),
// rate limiting (ST-09) and the field-crypto envelope. WebAuthn is tested in @hsp/testing (with the software
// authenticator); per-class KMS grants are tested with kms-local in apps/api (adapters can't be imported here).
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '@hsp/kernel';
import {
  blindIndex, constantTimeEqual, createFieldCrypto, createRateLimiter, csrfToken, FieldDecryptionError, hashSecret, JwtError,
  KeyMaterialError, localEs256Signer, MemoryRateLimitStore, needsRehash, numericCode, opaqueToken, otpCodeHmac, resolveClientIp,
  signClientIp, signJwt, SubjectKeyDestroyedError, verifyClientIpHeader, verifyCsrfToken, verifyJwt, verifySecret,
  type EncryptionContext, type KeyManagementPort, type StoredSubjectKey,
} from '../index.ts';

const key = randomBytes(32);

describe('hashing and codes', () => {
  it('blind index is keyed, normalised and 16 bytes; short keys are refused', () => {
    expect(blindIndex(key, ' +910000000101 ')).toEqual(blindIndex(key, '+910000000101'));
    expect(blindIndex(key, '+910000000101')).toHaveLength(16);
    expect(blindIndex(randomBytes(32), '+910000000101').equals(blindIndex(key, '+910000000101'))).toBe(false);
    expect(() => blindIndex(randomBytes(8), 'x')).toThrow(KeyMaterialError);
  });

  it('numeric codes and opaque tokens come from the CSPRNG with the right shape', () => {
    const codes = new Set(Array.from({ length: 200 }, () => numericCode(6)));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    expect(opaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => numericCode(3)).toThrow();
  });

  it('OTP HMAC binds the challenge id; comparison is constant-time and length-safe', () => {
    expect(otpCodeHmac(key, 'a', '123456').equals(otpCodeHmac(key, 'b', '123456'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });

  it('Argon2id PHC hashes verify, reject wrong secrets and malformed hashes', async () => {
    const phc = await hashSecret('2580');
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret(phc, '2580')).toBe(true);
    expect(await verifySecret(phc, '2581')).toBe(false);
    expect(await verifySecret('$argon2id$garbage', '2580')).toBe(false);
    expect(needsRehash(phc)).toBe(false);
    expect(needsRehash(await hashSecret('2580', { memoryKiB: 4096, passes: 1, parallelism: 1 }))).toBe(true);
  });
});

describe('ES256 JWT (ST-11)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = localEs256Signer('k1', privateKey);
  const keys = new Map([['k1', publicKey]]);
  const now = new Date('2026-10-09T10:00:00Z');
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { iss: 'https://auth.test.invalid', aud: 'tech-app', sub: 'u1', iat, exp: iat + 600, sid: 's1' };
  const opts = { keys, issuer: claims.iss, audience: 'tech-app', now, maxLifetimeSec: 600 };
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'OK';
    } catch (e) {
      return e instanceof JwtError ? e.code : 'OTHER';
    }
  };
  const forge = (header: object, payload: object, sig = '') =>
    `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;

  it('accepts a valid token', async () => {
    expect(verifyJwt(await signJwt(signer, claims), opts).sub).toBe('u1');
  });

  it('rejects alg=none, HS256 signed with the public key, RS-style and unknown kids', () => {
    expect(code(() => verifyJwt(forge({ alg: 'none', kid: 'k1' }, claims), opts))).toBe('MALFORMED'); // empty signature segment
    expect(code(() => verifyJwt(forge({ alg: 'none', kid: 'k1' }, claims, 'AA'), opts))).toBe('ALGORITHM');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const hs = createHmac('sha256', pem).update(`${h}.${p}`).digest('base64url');
    expect(code(() => verifyJwt(`${h}.${p}.${hs}`, opts))).toBe('ALGORITHM');
    expect(code(() => verifyJwt(forge({ alg: 'ES256', kid: 'other' }, claims, 'AA'), opts))).toBe('UNKNOWN_KEY');
    expect(code(() => verifyJwt(forge({ alg: 'ES256', kid: 'k1', jwk: {} }, claims, 'AA'), opts))).toBe('ALGORITHM');
  });

  it('rejects a wrong audience, issuer, expired, not-yet-valid, over-long and tampered tokens', async () => {
    expect(code(() => verifyJwt('x', opts))).toBe('MALFORMED');
    const t = (c: object) => signJwt(signer, { ...claims, ...c });
    for (const [c, expected] of [
      [{ aud: 'agent-web' }, 'AUDIENCE'], [{ iss: 'https://evil.invalid' }, 'ISSUER'], [{ exp: iat - 61 }, 'EXPIRED'],
      [{ iat: iat + 3600, exp: iat + 4000 }, 'NOT_YET_VALID'], [{ exp: iat + 86_400 }, 'LIFETIME'],
    ] as const) {
      const token = await t(c);
      expect(code(() => verifyJwt(token, opts)), JSON.stringify(c)).toBe(expected);
    }
    const good = await t({});
    const [h, p, s] = good.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: 'u2' })).toString('base64url')}.${s}`;
    expect(p).toBeDefined();
    expect(code(() => verifyJwt(tampered, opts))).toBe('SIGNATURE');
  });
});

describe('request trust (ST-27 client IP, ST-12 CSRF)', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const base = { trustedPeer: 'web-bff', headerKey: key, now };

  it('ignores X-Forwarded-For and unsigned / forged / stale client-IP headers', () => {
    const conn = (headers: Record<string, string>, peerIdentity?: string) => ({ peerAddress: '10.0.0.5', peerIdentity, headers });
    expect(resolveClientIp(conn({ 'x-forwarded-for': '1.2.3.4' }), base)).toBe('10.0.0.5');
    expect(resolveClientIp(conn({ 'x-client-ip': signClientIp(key, '1.2.3.4', now) }), base)).toBe('10.0.0.5'); // not the BFF
    expect(resolveClientIp(conn({ 'x-client-ip': signClientIp(randomBytes(32), '1.2.3.4', now) }, 'web-bff'), base)).toBe('10.0.0.5');
    expect(resolveClientIp(conn({ 'x-client-ip': signClientIp(key, '1.2.3.4', new Date(now.getTime() - 60_000)) }, 'web-bff'), base)).toBe('10.0.0.5');
    expect(resolveClientIp(conn({ 'x-client-ip': 'v1.1.1.2.3.4.AAAA' }, 'web-bff'), base)).toBe('10.0.0.5');
    expect(resolveClientIp(conn({ 'x-client-ip': signClientIp(key, '1.2.3.4', now) }, 'web-bff'), base)).toBe('1.2.3.4');
    expect(verifyClientIpHeader(key, signClientIp(key, '2001:db8::1', now), now)).toBe('2001:db8::1');
  });

  it('CSRF tokens are bound to the session and compared safely', () => {
    const t = csrfToken(key, 'session-a');
    expect(verifyCsrfToken(key, 'session-a', t)).toBe(true);
    expect(verifyCsrfToken(key, 'session-b', t)).toBe(false);
    expect(verifyCsrfToken(key, 'session-a', undefined)).toBe(false);
    expect(verifyCsrfToken(randomBytes(32), 'session-a', t)).toBe(false);
  });
});

describe('rate limiter (token bucket)', () => {
  it('denies after the burst, refills over the window, and reports retry-after', async () => {
    const limiter = createRateLimiter(new MemoryRateLimitStore());
    const rule = { name: 'per_ip', capacity: 3, windowSec: 60 };
    const t0 = new Date('2026-10-09T10:00:00Z');
    for (let i = 0; i < 3; i += 1) expect((await limiter.consume([{ rule, key: 'a' }], t0)).allowed).toBe(true);
    const denied = await limiter.consume([{ rule, key: 'a' }], t0);
    expect(denied).toMatchObject({ allowed: false, limitedBy: 'per_ip' });
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect((await limiter.consume([{ rule, key: 'b' }], t0)).allowed).toBe(true); // other key unaffected
    expect((await limiter.consume([{ rule, key: 'a' }], new Date(t0.getTime() + 20_001))).allowed).toBe(true);
    expect((await limiter.consume([{ rule, key: undefined }], t0)).allowed).toBe(true); // missing dimension skipped
  });
});

describe('field crypto envelope (SR-06 / SR-07)', () => {
  function memoryKms(): KeyManagementPort {
    const master = randomBytes(32);
    return {
      async generateDataKey() {
        const plaintext = randomBytes(32);
        return { plaintext, wrapped: Buffer.concat([plaintext.map((b, i) => b ^ (master[i] ?? 0))]), keyId: 'mem' };
      },
      async decryptDataKey(wrapped) {
        return Buffer.from(wrapped.map((b, i) => b ^ (master[i] ?? 0)));
      },
    };
  }
  function memoryStore() {
    const m = new Map<string, StoredSubjectKey>();
    const k = (c: EncryptionContext) => `${c.subjectId}|${c.dataClass}`;
    return {
      store: {
        async find(c: EncryptionContext) { return m.get(k(c)); },
        async insertIfAbsent(c: EncryptionContext, wrapped: Buffer, keyId: string) { if (!m.has(k(c))) m.set(k(c), { wrapped, keyId }); },
      },
      destroy(subjectId: string) { for (const key of m.keys()) if (key.startsWith(`${subjectId}|`)) m.set(key, { destroyed: true }); },
    };
  }

  it('round-trips, binds subject and class, and is unreadable after the subject key is destroyed', async () => {
    const { store, destroy } = memoryStore();
    const fc = createFieldCrypto({ kms: memoryKms(), store, clock: new ManualClock(new Date()) });
    const a = { subjectId: 'user-a', dataClass: 'pii-contact' } as const;
    const env = await fc.seal(a, '+910000000101');
    expect(env.includes(Buffer.from('+910000000101'))).toBe(false);
    expect(await fc.open(a, env)).toBe('+910000000101');
    await fc.seal({ subjectId: 'user-b', dataClass: 'pii-contact' }, 'x');
    await expect(fc.open({ subjectId: 'user-b', dataClass: 'pii-contact' }, env)).rejects.toThrow(FieldDecryptionError);
    await expect(fc.open({ subjectId: 'user-a', dataClass: 'pii-address' }, env)).rejects.toThrow(FieldDecryptionError);
    destroy('user-a');
    fc.forgetSubject('user-a');
    await expect(fc.open(a, env)).rejects.toThrow(SubjectKeyDestroyedError);
    await expect(fc.seal(a, 'new')).rejects.toThrow(SubjectKeyDestroyedError);
  });
});
