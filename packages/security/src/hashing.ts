// Keyed hashing primitives (Phase 1 03 §1, 05 §4, 11 §2): blind indexes, HMACs, constant-time comparison.
// Keys (peppers) come from configuration (Secrets Manager when deployed; generated test values locally).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MIN_KEY_BYTES = 32;

export class KeyMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyMaterialError';
  }
}

/** Refuses short or missing key material. Never echoes the key. */
export function assertKey(key: Uint8Array, purpose: string): void {
  if (key.length < MIN_KEY_BYTES) throw new KeyMaterialError(`${purpose}: key must be at least ${MIN_KEY_BYTES} bytes`);
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Constant-time equality. Different lengths still do a comparison so timing doesn't reveal the length check. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Blind index (Phase 1 03 §1): HMAC-SHA256 over the normalised value, truncated to 16 bytes. */
export function blindIndex(pepper: Uint8Array, value: string): Buffer {
  assertKey(pepper, 'blind index pepper');
  return hmacSha256(pepper, value.trim().toLowerCase()).subarray(0, 16);
}

/** Keyed, rotatable reference for logs (11 §2 `actor_ref`): log readers can't join it to the users table. */
export function logRef(key: Uint8Array, id: string): string {
  assertKey(key, 'log reference key');
  return `r_${hmacSha256(key, id).subarray(0, 8).toString('hex')}`;
}
