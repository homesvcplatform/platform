// Argon2id wrapper (Phase 1 05 §2.3: IVR PINs). Node's built-in implementation, PHC string format so parameters can be
// raised later without breaking stored hashes. Parameters: OWASP minimum for Argon2id (19 MiB, 2 passes, 1 lane).
import { argon2, randomBytes } from 'node:crypto';
import { constantTimeEqual } from './hashing.ts';

export interface Argon2Params {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
}

export const ARGON2_DEFAULTS: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 };
const TAG_LENGTH = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

function derive(secret: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: secret, nonce: salt, parallelism: p.parallelism, tagLength: TAG_LENGTH, memory: p.memoryKiB, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashSecret(secret: string, params: Argon2Params = ARGON2_DEFAULTS): Promise<string> {
  const salt = randomBytes(16);
  const tag = await derive(secret, salt, params);
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Verifies `secret` against a stored PHC string. Malformed hashes never verify. */
export async function verifySecret(phc: string, secret: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const [, memory, passes, lanes, salt, tag] = m;
  const params = { memoryKiB: Number(memory), passes: Number(passes), parallelism: Number(lanes) };
  if (params.memoryKiB < 8 * params.parallelism || params.passes < 1 || params.parallelism < 1) return false;
  const derived = await derive(secret, Buffer.from(salt ?? '', 'base64'), params);
  return constantTimeEqual(derived, Buffer.from(tag ?? '', 'base64'));
}

/** True when the stored hash uses weaker parameters than the current defaults (re-hash on next success). */
export function needsRehash(phc: string, params: Argon2Params = ARGON2_DEFAULTS): boolean {
  const m = PHC.exec(phc);
  if (!m) return true;
  return Number(m[1]) < params.memoryKiB || Number(m[2]) < params.passes;
}
