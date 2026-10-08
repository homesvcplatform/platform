// Adapter "kms-local": local/CI emulation of the KMS design in SR-06 (TE-02: no AWS).
// - One master key per data class (the per-class CMKs). Data keys are wrapped with AES-256-GCM, with the encryption
//   context {subject_id, data_class} as associated data, so a wrong context fails to unwrap.
// - Per-role grants mirror the CMK key policies: a role without a grant for a class can neither generate nor
//   decrypt that class's data keys (Gate 3 exit criterion "KMS decrypt denied for roles without the class grant").
// - An ES256 signing key emulates the asymmetric access-token CMK.
// Never for real data: the key material lives in process memory (or is derived from a local seed).
import { createCipheriv, createDecipheriv, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { assertNonProduction } from '@hsp/kernel';
import {
  canonicalContext, DATA_CLASSES, KmsAccessDeniedError, localEs256Signer, type DataClass, type EncryptionContext,
  type JwtSigner, type KeyManagementPort,
} from '@hsp/security';

/** Grants named by SR-06. Roles not listed (worker, webhook, scheduler, ...) get no data-class grant. */
export const SR06_ROLE_GRANTS: Readonly<Record<string, readonly DataClass[]>> = {
  api: ['pii-contact', 'pii-address'],
  voice: ['pii-contact', 'pii-address'],
  'admin-api': DATA_CLASSES,
};

export interface LocalKeyring {
  forRole(role: string, grants?: Readonly<Record<string, readonly DataClass[]>>): KeyManagementPort;
}

const NONCE = 12;
const TAG = 16;

function keyring(masterKeys: ReadonlyMap<DataClass, Buffer>): LocalKeyring {
  return {
    forRole(role, grants = SR06_ROLE_GRANTS) {
      const allowed = new Set(grants[role] ?? []);
      const master = (ctx: EncryptionContext): Buffer => {
        if (!allowed.has(ctx.dataClass)) throw new KmsAccessDeniedError(role, ctx.dataClass);
        const key = masterKeys.get(ctx.dataClass);
        if (!key) throw new Error(`no master key for ${ctx.dataClass}`);
        return key;
      };
      return {
        async generateDataKey(ctx) {
          const key = master(ctx);
          const plaintext = randomBytes(32);
          const nonce = randomBytes(NONCE);
          const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
          cipher.setAAD(canonicalContext(ctx));
          const wrapped = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
          return { plaintext, wrapped, keyId: `kms-local:${ctx.dataClass}` };
        },
        async decryptDataKey(wrapped, keyId, ctx) {
          const key = master(ctx);
          if (keyId !== `kms-local:${ctx.dataClass}`) throw new Error('KMS: key id does not match the data class');
          if (wrapped.length !== NONCE + 32 + TAG) throw new Error('KMS: malformed wrapped key');
          const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, NONCE), { authTagLength: TAG });
          decipher.setAAD(canonicalContext(ctx));
          decipher.setAuthTag(wrapped.subarray(wrapped.length - TAG));
          try {
            return Buffer.concat([decipher.update(wrapped.subarray(NONCE, wrapped.length - TAG)), decipher.final()]);
          } catch {
            throw new Error('KMS: invalid ciphertext or encryption context');
          }
        },
      };
    },
  };
}

/** A keyring with fresh random master keys (tests). */
export function createEphemeralKeyring(env: Readonly<Record<string, string | undefined>> = process.env): LocalKeyring {
  assertNonProduction(env);
  return keyring(new Map(DATA_CLASSES.map((c) => [c, randomBytes(32)])));
}

/** A keyring derived from a local seed (≥ 32 bytes, base64), so local data survives restarts. Never for real data. */
export function createSeededKeyring(seedBase64: string, env: Readonly<Record<string, string | undefined>> = process.env): LocalKeyring {
  assertNonProduction(env);
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length < 32) throw new Error('kms-local seed must be at least 32 bytes');
  return keyring(new Map(DATA_CLASSES.map((c) => [c, Buffer.from(hkdfSync('sha256', seed, 'hsp-kms-local', `cmk:${c}`, 32))])));
}

/** Emulated asymmetric signing CMK for access tokens: the signer plus the public keys a verifier needs. */
export function createLocalTokenSigningKey(kid: string, env: Readonly<Record<string, string | undefined>> = process.env): {
  readonly signer: JwtSigner;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
} {
  assertNonProduction(env);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { signer: localEs256Signer(kid, privateKey), publicKeys: new Map([[kid, publicKey]]) };
}
