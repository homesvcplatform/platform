// Audit log writer (Phase 1 05 §10, 11 §8): the platform writer behind compliance's `audit(event)` facade. Runs on the
// caller's transaction client, as the last statement of the transaction (it takes the per-month chain head lock).
// The hash chain is computed in the database (platform.append_audit_log), so no runtime role can insert rows directly.
// change_summary holds field names and redacted, enum-like values only: never personal data or secrets.
import { isFieldAllowed } from '@hsp/observability';
import { newId } from '@hsp/kernel';
import type { Queryable } from './migrate.ts';

export type AuditActorType = 'CUSTOMER' | 'TECHNICIAN' | 'FIELD_AGENT' | 'ADMIN' | 'SYSTEM';
export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';
export type AuditValue = boolean | number | null | string | readonly string[];

export interface AuditEntry {
  readonly actorType: AuditActorType;
  readonly actorId?: string | null;
  readonly actorSessionId?: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly cityId?: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string | null;
  readonly changeSummary?: Readonly<Record<string, AuditValue>>;
  readonly requestId?: string | null;
  readonly ipHash?: Buffer | null;
  readonly uaHash?: Buffer | null;
}

export class AuditEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEntryError';
  }
}

/** Enum-like tokens, UUIDs and field names only. Free text can't reach the audit log. */
const SAFE_STRING = /^(?:[A-Za-z][A-Za-z0-9_.:-]{0,63}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,60}$/;

export function validateChangeSummary(summary: Readonly<Record<string, AuditValue>>): void {
  const keys = Object.keys(summary);
  if (keys.length > 32) throw new AuditEntryError('change_summary has too many fields');
  for (const key of keys) {
    if (!isFieldAllowed(key)) throw new AuditEntryError(`change_summary field "${key}" is not allowed (PII / secret-like name)`);
    const value = summary[key];
    const ok = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && SAFE_STRING.test(v));
    if (Array.isArray(value) ? !(value.length <= 32 && value.every((v) => typeof v === 'string' && SAFE_STRING.test(v))) : !ok(value)) {
      throw new AuditEntryError(`change_summary field "${key}" has a value that isn't an enum, number, flag, id or field list`);
    }
  }
}

/** Appends one hash-chained audit row. Returns the audit row id. */
export async function appendAudit(client: Queryable, entry: AuditEntry): Promise<string> {
  if (entry.changeSummary) validateChangeSummary(entry.changeSummary);
  if (entry.reasonCode != null && !REASON_CODE.test(entry.reasonCode)) throw new AuditEntryError('reason codes are UPPER_SNAKE constants');
  const id = newId();
  await client.query(
    'SELECT platform.append_audit_log($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [id, entry.actorType, entry.actorId ?? null, entry.actorSessionId ?? null, entry.action, entry.resourceType,
      entry.resourceId ?? null, entry.cityId ?? null, entry.outcome, entry.reasonCode ?? null,
      entry.changeSummary ? JSON.stringify(entry.changeSummary) : null, entry.requestId ?? null, entry.ipHash ?? null, entry.uaHash ?? null],
  );
  return id;
}
