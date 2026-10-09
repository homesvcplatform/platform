// Gate 3 review fix: the admin-api composition fails closed without a shared, atomic rate-limit store outside local / test.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createEphemeralKeyring, createLocalTokenSigningKey } from '@hsp/adapter-kms-local';
import { systemClock, type AppEnvironment } from '@hsp/kernel';
import { createLogger } from '@hsp/observability';
import { MemoryRateLimitStore, RateLimitConfigError, type RateLimitStore } from '@hsp/security';
import { createTestIdp } from '@hsp/testing';
import { composeAdminApi } from '../bootstrap.ts';

const env = { APP_ENV: 'test' };
const signing = createLocalTokenSigningKey('k-compose-admin', env);
const shared: RateLimitStore = { shared: true, take: async () => ({ allowed: true, retryAfterSec: 0 }) };

function compose(appEnv: AppEnvironment, rateLimitStore: RateLimitStore | undefined) {
  return composeAdminApi({
    pool: new pg.Pool({ max: 1 }), clock: systemClock, logger: createLogger('hsp-compose-test', 'error', () => undefined),
    idp: createTestIdp().config, webauthn: { rpId: 'admin.test.invalid', origin: 'https://admin.test.invalid' }, csrfKey: randomBytes(32),
    requestHashKey: randomBytes(32), allowedOrigins: [], appEnv, rateLimitStore,
    identity: { kms: createEphemeralKeyring(env).forRole('admin-api'), keys: { otpPepper: randomBytes(32), blindIndexPepper: randomBytes(32),
      refreshRotationKey: randomBytes(32), csrfKey: randomBytes(32), requestHashKey: randomBytes(32) }, tokenSigner: signing.signer,
      tokenVerificationKeys: signing.publicKeys, issuer: 'https://auth.test.invalid' },
  });
}

describe('admin-api composition: rate-limit store', () => {
  it('refuses to start without a store, and with the in-memory store in a deployed environment', () => {
    for (const e of ['local', 'dev', 'test', 'staging'] as const) expect(() => compose(e, undefined), e).toThrow(RateLimitConfigError);
    for (const e of ['dev', 'staging'] as const) expect(() => compose(e, new MemoryRateLimitStore()), e).toThrow(/shared, atomic/);
  });

  it('passkey ceremonies are refused in deployed environments until the WebAuthn review passes (ADR-024 #2)', async () => {
    const admin = { kind: 'ADMIN' as const, id: 'a1', sessionId: 's1', permissions: new Map() };
    for (const e of ['dev', 'staging'] as const) {
      const app = compose(e, shared);
      await expect(app.backoffice.beginStepUp(admin, { operation: 'backoffice.passkey.register' }), e).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(app.backoffice.beginPasskeyRegistration(admin), e).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('accepts the in-memory store only in local / test, and a shared store anywhere', () => {
    for (const e of ['local', 'test'] as const) expect(compose(e, new MemoryRateLimitStore()).policies.has('backoffice.grant.request')).toBe(true);
    for (const e of ['dev', 'staging'] as const) expect(compose(e, shared).policies.has('backoffice.grant.request')).toBe(true);
  });
});
