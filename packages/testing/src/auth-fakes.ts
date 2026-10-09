// Test-only authentication fakes (TE-02: no real IdP, no real authenticators):
// - a test IdP / zero-trust proxy that mints ES256 assertions with chosen authentication methods;
// - a software WebAuthn authenticator (P-256, attestation "none") producing real registration and assertion payloads.
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { localEs256Signer, signJwt } from '@hsp/security';

export interface TestIdp {
  readonly config: { readonly issuer: string; readonly audience: string; readonly keys: ReadonlyMap<string, KeyObject>; readonly maxLifetimeSec: number };
  mint(subject: string, opts?: { amr?: string[]; acr?: string; ttlSec?: number; now?: Date; audience?: string }): Promise<string>;
}

export function createTestIdp(opts: { issuer?: string; audience?: string } = {}): TestIdp {
  const kid = `test-idp-${randomBytes(4).toString('hex')}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = localEs256Signer(kid, privateKey);
  const issuer = opts.issuer ?? 'https://idp.test.invalid';
  const audience = opts.audience ?? 'admin-api';
  return {
    config: { issuer, audience, keys: new Map([[kid, publicKey]]), maxLifetimeSec: 300 },
    mint(subject, o = {}) {
      const iat = Math.floor((o.now ?? new Date()).getTime() / 1000);
      return signJwt(signer, { iss: issuer, aud: o.audience ?? audience, sub: subject, iat, exp: iat + (o.ttlSec ?? 120),
        amr: o.amr ?? ['hwk', 'user'], ...(o.acr ? { acr: o.acr } : {}) });
    },
  };
}

// ---- minimal CBOR encoder (definite lengths; ints, byte strings, text, arrays, maps)
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
type CborIn = number | string | Buffer | CborIn[] | Map<number | string, CborIn>;
export function encodeCbor(v: CborIn): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
}

const sha256 = (d: Buffer | string) => createHash('sha256').update(d).digest();

export interface SoftAuthenticator {
  readonly credentialId: string;
  register(challenge: string, opts?: { origin?: string; rpId?: string; userVerified?: boolean }): { clientDataJSON: Buffer; attestationObject: Buffer };
  assert(challenge: string, opts?: { origin?: string; rpId?: string; userVerified?: boolean; signCount?: number }): {
    credentialId: string; clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer;
  };
}

export function createSoftAuthenticator(rpId: string, origin: string): SoftAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(32);
  let counter = 0;
  const flags = (uv: boolean, at: boolean) => 0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0);
  const cose = new Map<number | string, CborIn>([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x ?? '', 'base64url')], [-3, Buffer.from(jwk.y ?? '', 'base64url')]]);
  return {
    credentialId: credId.toString('base64url'),
    register(challenge, o = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? origin, crossOrigin: false }));
      const count = Buffer.alloc(4);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(o.rpId ?? rpId), Buffer.from([flags(o.userVerified ?? true, true)]), count,
        Buffer.alloc(16), idLen, credId, encodeCbor(cose)]);
      const attestationObject = encodeCbor(new Map<number | string, CborIn>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { clientDataJSON, attestationObject };
    },
    assert(challenge, o = {}) {
      counter = o.signCount ?? counter + 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? origin }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([sha256(o.rpId ?? rpId), Buffer.from([flags(o.userVerified ?? true, false)]), count]);
      const signature = cryptoSign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: 'der' });
      return { credentialId: credId.toString('base64url'), clientDataJSON, authenticatorData, signature };
    },
  };
}
