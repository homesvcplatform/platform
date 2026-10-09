// Gate 3 review fix: the api composition fails closed without a shared, atomic rate-limit store outside local / test.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createEphemeralKeyring, createLocalTokenSigningKey } from '@hsp/adapter-kms-local';
import { systemClock, type AppEnvironment } from '@hsp/kernel';
import { createLogger } from '@hsp/observability';
import { MemoryRateLimitStore, RateLimitConfigError, type RateLimitStore } from '@hsp/security';
import { composeApi } from '../bootstrap.ts';

const env = { APP_ENV: 'test' };
const signing = createLocalTokenSigningKey('k-compose', env);
const shared: RateLimitStore = { shared: true, take: async () => ({ allowed: true, retryAfterSec: 0 }) };

function compose(appEnv: AppEnvironment, rateLimitStore: RateLimitStore | undefined) {
  return composeApi({
    pool: new pg.Pool({ max: 1 }), clock: systemClock, logger: createLogger('hsp-compose-test', 'error', () => undefined),
    kms: createEphemeralKeyring(env).forRole('api'), tokenSigner: signing.signer, tokenVerificationKeys: signing.publicKeys,
    issuer: 'https://auth.test.invalid', keys: { otpPepper: randomBytes(32), blindIndexPepper: randomBytes(32), refreshRotationKey: randomBytes(32),
      csrfKey: randomBytes(32), requestHashKey: randomBytes(32) }, otpSender: { sendOtp: async () => ({ accepted: false }) },
    eligibility: { isEligible: async () => false }, botVerifier: { verify: async () => false }, phonePolicy: 'RESERVED_TEST_RANGE_ONLY',
    allowedWebOrigins: [], appEnv, rateLimitStore,
  });
}

describe('api composition: rate-limit store', () => {
  it('refuses to start without a store, and with the in-memory store in a deployed environment', () => {
    for (const e of ['local', 'dev', 'test', 'staging'] as const) expect(() => compose(e, undefined), e).toThrow(RateLimitConfigError);
    for (const e of ['dev', 'staging'] as const) expect(() => compose(e, new MemoryRateLimitStore()), e).toThrow(/shared, atomic/);
  });

  it('accepts the in-memory store only in local / test, and a shared store anywhere', () => {
    for (const e of ['local', 'test'] as const) expect(compose(e, new MemoryRateLimitStore()).policies.has('identity.otp.request')).toBe(true);
    for (const e of ['dev', 'staging'] as const) expect(compose(e, shared).policies.has('identity.otp.request')).toBe(true);
  });
});
