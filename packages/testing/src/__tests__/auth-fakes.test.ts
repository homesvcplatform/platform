// Gate 3: WebAuthn verification (SR-03 passkeys) against the software authenticator, and the test IdP.
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { opaqueToken, verifyAssertion, verifyJwt, verifyRegistration, WebAuthnError } from '@hsp/security';
import { createSoftAuthenticator, createTestIdp } from '../auth-fakes.ts';

describe('WebAuthn (SR-03 passkeys)', () => {
  const rpId = 'admin.test.invalid';
  const origin = 'https://admin.test.invalid';
  const challenge = opaqueToken(32);

  it('registers an ES256 passkey and verifies assertions with UV, origin, RP ID and counter checks', () => {
    const auth = createSoftAuthenticator(rpId, origin);
    const reg = auth.register(challenge);
    const cred = verifyRegistration({ ...reg, expectedChallenge: challenge, expectedOrigin: origin, rpId });
    expect(cred.credentialId).toBe(auth.credentialId);
    const c2 = opaqueToken(32);
    const a = auth.assert(c2);
    const base = { expectedChallenge: c2, expectedOrigin: origin, rpId, publicKeySpki: cred.publicKeySpki, storedSignCount: 0 };
    expect(verifyAssertion({ ...a, ...base }).signCount).toBe(1);
    const err = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return e instanceof WebAuthnError ? e.code : 'OTHER'; } };
    expect(err(() => verifyAssertion({ ...a, ...base, expectedChallenge: opaqueToken(32) }))).toBe('CHALLENGE');
    expect(err(() => verifyAssertion({ ...auth.assert(c2, { origin: 'https://evil.invalid' }), ...base }))).toBe('ORIGIN');
    expect(err(() => verifyAssertion({ ...auth.assert(c2, { rpId: 'evil.invalid' }), ...base }))).toBe('RP_ID');
    expect(err(() => verifyAssertion({ ...auth.assert(c2, { userVerified: false }), ...base }))).toBe('USER_VERIFICATION');
    expect(err(() => verifyAssertion({ ...auth.assert(c2, { signCount: 3 }), ...base, storedSignCount: 5 }))).toBe('SIGN_COUNT');
    const other = createSoftAuthenticator(rpId, origin).assert(c2);
    expect(err(() => verifyAssertion({ ...other, ...base }))).toBe('SIGNATURE');
    const bad = Buffer.from(cryptoSign('sha256', Buffer.from('x'), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey));
    expect(err(() => verifyAssertion({ ...a, ...base, signature: bad }))).toBe('SIGNATURE');
  });

  it('refuses registrations without user verification, with attestation or for another origin', () => {
    const auth = createSoftAuthenticator(rpId, origin);
    const err = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return e instanceof WebAuthnError ? e.code : 'OTHER'; } };
    const reg = (o: Parameters<typeof auth.register>[1]) => auth.register(challenge, o);
    const v = (r: { clientDataJSON: Buffer; attestationObject: Buffer }) => verifyRegistration({ ...r, expectedChallenge: challenge, expectedOrigin: origin, rpId });
    expect(err(() => v(reg({ userVerified: false })))).toBe('USER_VERIFICATION');
    expect(err(() => v(reg({ origin: 'https://evil.invalid' })))).toBe('ORIGIN');
    expect(err(() => v({ ...reg({}), attestationObject: Buffer.from([0xa0]) }))).toBe('ATTESTATION_FORMAT');
    expect(err(() => v({ ...reg({}), attestationObject: Buffer.from([0xff]) }))).toBe('CBOR_UNSUPPORTED');
  });
});

describe('test IdP', () => {
  it('mints ES256 assertions that verify with its public keys', async () => {
    const idp = createTestIdp();
    const token = await idp.mint('admin-subject-1', { amr: ['hwk'] });
    const claims = verifyJwt(token, { keys: idp.config.keys, issuer: idp.config.issuer, audience: idp.config.audience, now: new Date() });
    expect(claims.sub).toBe('admin-subject-1');
    expect(claims['amr']).toEqual(['hwk']);
  });
});
