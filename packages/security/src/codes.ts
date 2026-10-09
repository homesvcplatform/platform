// One-time codes and opaque tokens (Phase 1 05 §3.2, §4). CSPRNG only. Codes are stored as HMACs, tokens as SHA-256.
import { randomBytes, randomInt } from 'node:crypto';
import { assertKey, hmacSha256, sha256 } from './hashing.ts';

/** A numeric code of `digits` length from the CSPRNG (uniform per digit). */
export function numericCode(digits: number): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 10) throw new RangeError('digits must be 4..10');
  let code = '';
  for (let i = 0; i < digits; i += 1) code += String(randomInt(10));
  return code;
}

/** Opaque bearer secret (refresh tokens, session cookies, WebAuthn challenges). base64url, 256 bits by default. */
export function opaqueToken(bytes = 32): string {
  if (bytes < 16) throw new RangeError('tokens need at least 128 bits');
  return randomBytes(bytes).toString('base64url');
}

/** Storage form of an opaque token: SHA-256 (tokens are high-entropy, so no salt or KDF is needed). */
export function tokenHash(token: string): Buffer {
  return sha256(token);
}

/** OTP storage form (05 §4): HMAC(pepper, challengeId ‖ code). The code itself is never stored. */
export function otpCodeHmac(pepper: Uint8Array, challengeId: string, code: string): Buffer {
  assertKey(pepper, 'OTP pepper');
  return hmacSha256(pepper, `${challengeId}|${code}`);
}
