// WebAuthn (passkey) verification for admin login step-up and high-risk re-authentication (Phase 1 05 §2.5, SR-03).
// Deliberately narrow: ES256 (COSE alg -7) credentials, attestation format "none" (passkeys), user presence AND user
// verification required, exact challenge / origin / RP ID checks, and signature-counter regression detection.
// The CBOR decoder accepts only definite-length major types 0-5 and simple values; anything else is rejected.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { constantTimeEqual, sha256 } from './hashing.ts';

export class WebAuthnError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`WebAuthn verification failed: ${code}`);
    this.name = 'WebAuthnError';
    this.code = code;
  }
}

type Cbor = number | bigint | Buffer | string | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Decodes one CBOR item at `offset`. Returns the value and the offset after it. */
export function decodeCbor(buf: Buffer, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 16) throw new WebAuthnError('CBOR_DEPTH');
  const first = buf[offset];
  if (first === undefined) throw new WebAuthnError('CBOR_TRUNCATED');
  const major = first >> 5;
  const info = first & 0x1f;
  let pos = offset + 1;
  const readLength = (): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0 || pos + size > buf.length) throw new WebAuthnError('CBOR_LENGTH');
    const n = size === 8 ? buf.readBigUInt64BE(pos) : BigInt(buf.readUIntBE(pos, size));
    pos += size;
    if (n > BigInt(buf.length)) throw new WebAuthnError('CBOR_LENGTH');
    return Number(n);
  };
  switch (major) {
    case 0: return { value: readLength(), end: pos };
    case 1: return { value: -1 - readLength(), end: pos };
    case 2:
    case 3: {
      const len = readLength();
      if (pos + len > buf.length) throw new WebAuthnError('CBOR_TRUNCATED');
      const bytes = buf.subarray(pos, pos + len);
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), end: pos + len };
    }
    case 4: {
      const len = readLength();
      const items: Cbor[] = [];
      for (let i = 0; i < len; i += 1) {
        const item = decodeCbor(buf, pos, depth + 1);
        items.push(item.value);
        pos = item.end;
      }
      return { value: items, end: pos };
    }
    case 5: {
      const len = readLength();
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < len; i += 1) {
        const k = decodeCbor(buf, pos, depth + 1);
        const v = decodeCbor(buf, k.end, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new WebAuthnError('CBOR_KEY');
        if (map.has(k.value)) throw new WebAuthnError('CBOR_DUPLICATE_KEY');
        map.set(k.value, v.value);
        pos = v.end;
      }
      return { value: map, end: pos };
    }
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      throw new WebAuthnError('CBOR_UNSUPPORTED');
    default:
      throw new WebAuthnError('CBOR_UNSUPPORTED');
  }
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

interface ClientDataExpectation {
  readonly type: 'webauthn.create' | 'webauthn.get';
  readonly challenge: string;
  readonly origin: string;
}

function checkClientData(clientDataJSON: Buffer, exp: ClientDataExpectation): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(clientDataJSON.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new WebAuthnError('CLIENT_DATA');
  }
  if (data['type'] !== exp.type) throw new WebAuthnError('TYPE');
  if (typeof data['challenge'] !== 'string' || !constantTimeEqual(Buffer.from(data['challenge']), Buffer.from(exp.challenge))) {
    throw new WebAuthnError('CHALLENGE');
  }
  if (data['origin'] !== exp.origin) throw new WebAuthnError('ORIGIN');
  if (data['crossOrigin'] === true) throw new WebAuthnError('CROSS_ORIGIN');
}

function checkAuthData(authData: Buffer, rpId: string): { flags: number; signCount: number } {
  if (authData.length < 37) throw new WebAuthnError('AUTH_DATA');
  if (!authData.subarray(0, 32).equals(sha256(rpId))) throw new WebAuthnError('RP_ID');
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_UP) === 0) throw new WebAuthnError('USER_PRESENCE');
  if ((flags & FLAG_UV) === 0) throw new WebAuthnError('USER_VERIFICATION');
  return { flags, signCount: authData.readUInt32BE(33) };
}

function coseToPublicKey(cose: Cbor): KeyObject {
  if (!(cose instanceof Map)) throw new WebAuthnError('COSE');
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new WebAuthnError('UNSUPPORTED_KEY');
  }
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
}

export interface RegistrationInput {
  readonly clientDataJSON: Buffer;
  readonly attestationObject: Buffer;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly rpId: string;
}

export interface RegisteredCredential {
  readonly credentialId: string;
  readonly publicKeySpki: Buffer;
  readonly signCount: number;
  readonly backupEligible: boolean;
}

export function verifyRegistration(input: RegistrationInput): RegisteredCredential {
  checkClientData(input.clientDataJSON, { type: 'webauthn.create', challenge: input.expectedChallenge, origin: input.expectedOrigin });
  const { value: att, end } = decodeCbor(input.attestationObject);
  if (end !== input.attestationObject.length || !(att instanceof Map)) throw new WebAuthnError('ATTESTATION');
  const attStmt = att.get('attStmt');
  if (att.get('fmt') !== 'none' || !(attStmt instanceof Map) || attStmt.size !== 0) throw new WebAuthnError('ATTESTATION_FORMAT');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('AUTH_DATA');
  const { flags, signCount } = checkAuthData(authData, input.rpId);
  if ((flags & FLAG_AT) === 0 || (flags & FLAG_ED) !== 0) throw new WebAuthnError('ATTESTED_DATA');
  if (authData.length < 55) throw new WebAuthnError('AUTH_DATA');
  const idLength = authData.readUInt16BE(53);
  if (idLength < 16 || idLength > 1023 || authData.length < 55 + idLength) throw new WebAuthnError('CREDENTIAL_ID');
  const credentialId = authData.subarray(55, 55 + idLength);
  const cose = decodeCbor(authData, 55 + idLength);
  if (cose.end !== authData.length) throw new WebAuthnError('AUTH_DATA_TRAILING');
  const key = coseToPublicKey(cose.value);
  return {
    credentialId: credentialId.toString('base64url'),
    publicKeySpki: key.export({ type: 'spki', format: 'der' }),
    signCount,
    backupEligible: (flags & FLAG_BE) !== 0,
  };
}

export interface AssertionInput {
  readonly clientDataJSON: Buffer;
  readonly authenticatorData: Buffer;
  readonly signature: Buffer;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly rpId: string;
  readonly publicKeySpki: Buffer;
  readonly storedSignCount: number;
}

export function verifyAssertion(input: AssertionInput): { readonly signCount: number; readonly backedUp: boolean } {
  checkClientData(input.clientDataJSON, { type: 'webauthn.get', challenge: input.expectedChallenge, origin: input.expectedOrigin });
  const { flags, signCount } = checkAuthData(input.authenticatorData, input.rpId);
  const key = createPublicKey({ key: input.publicKeySpki, format: 'der', type: 'spki' });
  const signed = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
  let ok: boolean;
  try {
    ok = cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, input.signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new WebAuthnError('SIGNATURE');
  // A counter that doesn't increase (when the authenticator uses counters) indicates a cloned authenticator.
  if ((signCount !== 0 || input.storedSignCount !== 0) && signCount <= input.storedSignCount) throw new WebAuthnError('SIGN_COUNT');
  return { signCount, backedUp: (flags & FLAG_BS) !== 0 };
}
