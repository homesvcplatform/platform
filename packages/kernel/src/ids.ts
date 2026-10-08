// Identifiers (Phase 1 03 §1, §14.1): UUIDv7 generated in the application (time-ordered, known before insert;
// the database has no default so a missing ID fails loudly). IDs are not secrets: knowing one grants nothing.
import { createHash } from 'node:crypto';
import { v7 as uuidv7, validate, version } from 'uuid';

export type Uuid = string & { readonly __brand: 'Uuid' };

export function newId(): Uuid {
  return uuidv7() as Uuid;
}

/**
 * Deterministic UUIDv7 for synthetic fixtures only: the same (namespace, name) always yields the same ID, so seed
 * loads are idempotent. The timestamp field is fixed to `epochMs`; the random bits come from SHA-256(namespace:name).
 */
export function fixtureId(namespace: string, name: string, epochMs = Date.UTC(2026, 0, 1)): Uuid {
  const digest = createHash('sha256').update(`${namespace}:${name}`).digest();
  return uuidv7({ msecs: epochMs, random: digest.subarray(0, 16) }) as Uuid;
}

export function isUuidV7(value: string): value is Uuid {
  return validate(value) && version(value) === 7;
}
