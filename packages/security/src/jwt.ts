// ES256 JSON Web Tokens (Phase 1 05 §3.1). The algorithm is pinned: `alg` must be exactly ES256 with a known `kid`,
// and the key must be a P-256 public key, so `none`, HS256-with-the-public-key and RSA confusion all fail (ST-11).
// Signing goes through a `JwtSigner` (an asymmetric KMS key when deployed; kms-local in local/CI).
import { createPrivateKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface JwtSigner {
  readonly kid: string;
  /** Returns the raw (IEEE P1363, r ‖ s) 64-byte ES256 signature of `signingInput`. */
  sign(signingInput: Buffer): Promise<Buffer>;
}

export type JwtErrorCode =
  | 'MALFORMED' | 'ALGORITHM' | 'UNKNOWN_KEY' | 'SIGNATURE' | 'ISSUER' | 'AUDIENCE' | 'EXPIRED' | 'NOT_YET_VALID' | 'LIFETIME';

export class JwtError extends Error {
  readonly code: JwtErrorCode;
  constructor(code: JwtErrorCode) {
    super(`JWT rejected: ${code}`);
    this.name = 'JwtError';
    this.code = code;
  }
}

export interface JwtClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly nbf?: number;
  readonly [claim: string]: unknown;
}

export interface VerifyOptions {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly issuer: string;
  readonly audience: string;
  readonly now: Date;
  readonly clockSkewSec?: number;
  /** Upper bound for exp - iat (defence against long-lived tokens minted with a stolen key). */
  readonly maxLifetimeSec?: number;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export async function signJwt(signer: JwtSigner, claims: JwtClaims): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: signer.kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = await signer.sign(Buffer.from(`${header}.${payload}`));
  if (signature.length !== 64) throw new Error('ES256 signer must return a 64-byte P1363 signature');
  return `${header}.${payload}.${b64url(signature)}`;
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JwtError('MALFORMED');
    return value as Record<string, unknown>;
  } catch {
    throw new JwtError('MALFORMED');
  }
}

function isP256PublicKey(key: KeyObject): boolean {
  return key.type === 'public' && key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

export function verifyJwt(token: string, opts: VerifyOptions): JwtClaims {
  if (token.length > 4096) throw new JwtError('MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) throw new JwtError('MALFORMED');
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  if (header['alg'] !== 'ES256' || (header['typ'] !== undefined && header['typ'] !== 'JWT') || 'crit' in header || 'jku' in header || 'jwk' in header || 'x5u' in header) {
    throw new JwtError('ALGORITHM');
  }
  const kid = header['kid'];
  const key = typeof kid === 'string' ? opts.keys.get(kid) : undefined;
  if (!key || !isP256PublicKey(key)) throw new JwtError('UNKNOWN_KEY');
  const signature = Buffer.from(s, 'base64url');
  const valid = signature.length === 64 && cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!valid) throw new JwtError('SIGNATURE');

  const claims = decodeJson(p);
  const skew = opts.clockSkewSec ?? 60;
  const now = Math.floor(opts.now.getTime() / 1000);
  const num = (name: string) => {
    const v = claims[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new JwtError('MALFORMED');
    return v;
  };
  const exp = num('exp');
  const iat = num('iat');
  const nbf = num('nbf');
  if (typeof claims['sub'] !== 'string' || exp === undefined || iat === undefined) throw new JwtError('MALFORMED');
  if (claims['iss'] !== opts.issuer) throw new JwtError('ISSUER');
  if (claims['aud'] !== opts.audience) throw new JwtError('AUDIENCE');
  if (now - skew >= exp) throw new JwtError('EXPIRED');
  if ((nbf !== undefined && now + skew < nbf) || now + skew < iat) throw new JwtError('NOT_YET_VALID');
  if (opts.maxLifetimeSec !== undefined && exp - iat > opts.maxLifetimeSec) throw new JwtError('LIFETIME');
  return claims as JwtClaims;
}

/** In-process ES256 signer around a private key (kms-local and the test IdP; deployed roles use KMS). */
export function localEs256Signer(kid: string, privateKey: KeyObject | string): JwtSigner {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('ES256 needs a P-256 key');
  return {
    kid,
    sign: async (input) => cryptoSign('sha256', input, { key, dsaEncoding: 'ieee-p1363' }),
  };
}
