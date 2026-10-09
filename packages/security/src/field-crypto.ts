// Field-level envelope encryption (Phase 1 03 §1, errata SR-06 / SR-07 / G-7).
// - One data key (DEK) per (subject, data class), wrapped by that data class's KMS key. A process role without the
//   class grant can't unwrap it (enforced by the KMS key policy; kms-local enforces the same grants in local/CI).
// - Encryption context {subject_id, data_class} is bound on every wrap/unwrap and as AEAD associated data, so a
//   ciphertext moved to another subject's row or column class doesn't decrypt.
// - Erasure destroys the subject's DEKs (crypto-shredding): everything sealed under them becomes unreadable.
// - Unwrapped DEKs are cached for at most 5 minutes.
// Column format: v1 ‖ len(key_ref) ‖ key_ref ‖ nonce(12) ‖ ciphertext ‖ tag(16), AES-256-GCM.
// SR-06: decryption is only for disclosure / reveal paths. ESLint restricts who may import `createFieldCrypto`.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Clock } from '@hsp/kernel';

export const DATA_CLASSES = ['pii-contact', 'pii-address', 'kyc', 'recordings', 'restricted-attributes'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export interface EncryptionContext {
  readonly subjectId: string;
  readonly dataClass: DataClass;
}

/** Canonical bytes of the encryption context (sorted keys), used as KMS context and AEAD associated data. */
export function canonicalContext(ctx: EncryptionContext): Buffer {
  return Buffer.from(JSON.stringify({ data_class: ctx.dataClass, subject_id: ctx.subjectId }), 'utf8');
}

export class KmsAccessDeniedError extends Error {
  constructor(role: string, dataClass: DataClass) {
    super(`KMS: role "${role}" has no grant for data class "${dataClass}"`);
    this.name = 'KmsAccessDeniedError';
  }
}

export class SubjectKeyDestroyedError extends Error {
  constructor() {
    super('The subject key was destroyed (erased subject); the value is unreadable');
    this.name = 'SubjectKeyDestroyedError';
  }
}

export class FieldDecryptionError extends Error {
  constructor(reason: string) {
    super(`Field decryption failed: ${reason}`);
    this.name = 'FieldDecryptionError';
  }
}

/** KMS port. Deployed: AWS KMS, one CMK per data class. Local/CI: @hsp/adapter-kms-local. */
export interface KeyManagementPort {
  generateDataKey(ctx: EncryptionContext): Promise<{ readonly plaintext: Buffer; readonly wrapped: Buffer; readonly keyId: string }>;
  decryptDataKey(wrapped: Buffer, keyId: string, ctx: EncryptionContext): Promise<Buffer>;
}

export type StoredSubjectKey = { readonly wrapped: Buffer; readonly keyId: string } | { readonly destroyed: true };

/** Storage of wrapped DEKs (identity.subject_keys). */
export interface SubjectKeyStore {
  find(ctx: EncryptionContext): Promise<StoredSubjectKey | undefined>;
  /** Inserts unless a key already exists for (subject, class); concurrent writers converge on one key. */
  insertIfAbsent(ctx: EncryptionContext, wrapped: Buffer, keyId: string): Promise<void>;
}

export interface FieldCrypto {
  seal(ctx: EncryptionContext, plaintext: string): Promise<Buffer>;
  open(ctx: EncryptionContext, envelope: Buffer): Promise<string>;
  /** Drops cached keys for a subject (call after erasure). */
  forgetSubject(subjectId: string): void;
}

const VERSION = 0x01;
const NONCE = 12;
const TAG = 16;
export const MAX_DEK_CACHE_MS = 5 * 60 * 1000;

const keyRefFor = (dataClass: DataClass) => Buffer.from(`dek:${dataClass}`, 'utf8');

/** Unwrapped-DEK cache shared by FieldCrypto instances of one process (entries live ≤ 5 minutes). */
export type DekCache = Map<string, { key: Buffer; expiresAt: number }>;
export const createDekCache = (): DekCache => new Map();

/**
 * `store` is usually bound to the caller's transaction (subject keys are inserted in the same transaction as the row
 * they protect), so create one FieldCrypto per transaction and share a process-wide `cache`.
 */
export function createFieldCrypto(deps: {
  readonly kms: KeyManagementPort;
  readonly store: SubjectKeyStore;
  readonly clock: Clock;
  readonly cache?: DekCache;
  readonly cacheTtlMs?: number;
}): FieldCrypto {
  const ttl = Math.min(deps.cacheTtlMs ?? MAX_DEK_CACHE_MS, MAX_DEK_CACHE_MS);
  const cache: DekCache = deps.cache ?? createDekCache();
  const cacheKey = (ctx: EncryptionContext) => `${ctx.subjectId}|${ctx.dataClass}`;

  async function dataKey(ctx: EncryptionContext, create: boolean): Promise<Buffer> {
    const now = deps.clock.now().getTime();
    const hit = cache.get(cacheKey(ctx));
    if (hit && hit.expiresAt > now) return hit.key;
    cache.delete(cacheKey(ctx));
    let stored = await deps.store.find(ctx);
    if (!stored) {
      if (!create) throw new FieldDecryptionError('no data key for this subject and class');
      const fresh = await deps.kms.generateDataKey(ctx);
      await deps.store.insertIfAbsent(ctx, fresh.wrapped, fresh.keyId);
      stored = await deps.store.find(ctx);
      if (!stored) throw new Error('subject key insert did not persist');
    }
    if ('destroyed' in stored) throw new SubjectKeyDestroyedError();
    const key = await deps.kms.decryptDataKey(stored.wrapped, stored.keyId, ctx);
    if (key.length !== 32) throw new FieldDecryptionError('data key has the wrong length');
    cache.set(cacheKey(ctx), { key, expiresAt: now + ttl });
    return key;
  }

  return {
    async seal(ctx, plaintext) {
      const key = await dataKey(ctx, true);
      const ref = keyRefFor(ctx.dataClass);
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
      cipher.setAAD(Buffer.concat([ref, canonicalContext(ctx)]));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION, ref.length]), ref, nonce, body, cipher.getAuthTag()]);
    },
    async open(ctx, envelope) {
      if (envelope[0] !== VERSION) throw new FieldDecryptionError('unknown envelope version');
      const refLength = envelope[1] ?? 0;
      if (envelope.length < 2 + refLength + NONCE + TAG) throw new FieldDecryptionError('envelope truncated');
      const ref = envelope.subarray(2, 2 + refLength);
      if (!ref.equals(keyRefFor(ctx.dataClass))) throw new FieldDecryptionError('data class mismatch');
      const key = await dataKey(ctx, false);
      const nonce = envelope.subarray(2 + refLength, 2 + refLength + NONCE);
      const body = envelope.subarray(2 + refLength + NONCE, envelope.length - TAG);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
      decipher.setAAD(Buffer.concat([ref, canonicalContext(ctx)]));
      decipher.setAuthTag(envelope.subarray(envelope.length - TAG));
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw new FieldDecryptionError('authentication failed');
      }
    },
    forgetSubject(subjectId) {
      for (const k of cache.keys()) if (k.startsWith(`${subjectId}|`)) cache.delete(k);
    },
  };
}
