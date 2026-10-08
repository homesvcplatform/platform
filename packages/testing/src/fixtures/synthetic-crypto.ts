// TEST-ONLY envelope encryption for SYNTHETIC fixture data (Gate 2 seed). Produces the documented column format
// (Phase 1 03 §1): v1 || key_ref || nonce || ciphertext || tag, AES-256-GCM, so encrypted columns hold realistic bytes.
// The key is derived from a public label: it protects nothing and must never be used for real data. Gate 3 replaces
// this with @hsp/security field crypto (per-subject DEKs under KMS / kms-local, encryption context).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const VERSION = 0x01;
const TAG_LENGTH = 16;
export const FIXTURE_KEY_REF = 'kms-local:synthetic-fixtures';

function fixtureKey(keyRef: string): Buffer {
  return createHash('sha256').update(`hsp-synthetic-fixtures-only:${keyRef}`).digest();
}

export function encryptFixture(plaintext: string, keyRef: string = FIXTURE_KEY_REF): Buffer {
  const ref = Buffer.from(keyRef, 'utf8');
  if (ref.length > 255) throw new RangeError('key ref too long');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fixtureKey(keyRef), nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(ref);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION, ref.length]), ref, nonce, body, cipher.getAuthTag()]);
}

export function decryptFixture(envelope: Buffer): string {
  if (envelope[0] !== VERSION) throw new Error('unknown envelope version');
  const refLength = envelope[1] ?? 0;
  if (envelope.length < 14 + refLength + TAG_LENGTH) throw new Error('envelope truncated');
  const ref = envelope.subarray(2, 2 + refLength);
  const nonce = envelope.subarray(2 + refLength, 14 + refLength);
  const tag = envelope.subarray(envelope.length - TAG_LENGTH);
  const body = envelope.subarray(14 + refLength, envelope.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', fixtureKey(ref.toString('utf8')), nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(ref);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Blind index (Phase 1 03 §1): HMAC-SHA256 truncated to 16 bytes. The pepper comes from the same public fixture derivation. */
export function blindIndexFixture(value: string): Buffer {
  return createHmac('sha256', fixtureKey(`${FIXTURE_KEY_REF}:blind-index-pepper`)).update(value.trim().toLowerCase()).digest().subarray(0, 16);
}

/** Fake Indian numbers in a reserved test range: +91 0000 0xxxxx (a leading 0 after +91 is never a real mobile). */
export function isReservedTestPhone(phone: string): boolean {
  return /^\+9100000[0-9]{5}$/.test(phone);
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)} ${phone.slice(3, 5)}•••••${phone.slice(-2)}`;
}
