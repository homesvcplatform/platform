// Idempotency records (Phase 1 04 §1.3, 03 §14.6): `Idempotency-Key` handling for endpoints declared "required".
// Runs on the caller's transaction client, so the record commits (or rolls back) with the command it protects:
// - same actor + key + endpoint + body hash → the stored response is replayed;
// - same key with a different body or endpoint → IDEMPOTENCY_KEY_REUSED (422);
// - the same key still being processed by another transaction → REQUEST_IN_PROGRESS (409, retry later);
// - an expired record (24 h default) is reused as a new request.
import type { Queryable } from './migrate.ts';

export class IdempotencyConflict extends Error {
  readonly reason: 'KEY_REUSED' | 'IN_PROGRESS';
  constructor(reason: 'KEY_REUSED' | 'IN_PROGRESS') {
    super(`idempotency conflict: ${reason}`);
    this.name = 'IdempotencyConflict';
    this.reason = reason;
  }
}

export interface IdempotencyRequest {
  /** 'admin:<uuid>' | 'user:<uuid>' | 'anon:<device hash>' (keys are scoped per actor). */
  readonly actorKey: string;
  readonly idemKey: string;
  /** Route template, e.g. 'POST /admin/v1/grants'. */
  readonly endpoint: string;
  /** SHA-256 of the canonical request body. */
  readonly requestHash: Buffer;
  readonly now: Date;
  readonly ttlMs?: number;
}

export type IdempotencyStart = { readonly kind: 'NEW' } | { readonly kind: 'REPLAY'; readonly status: number; readonly body: unknown };

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** How long a second request waits for an in-flight one before answering 409. */
const IN_FLIGHT_WAIT = '2s';

const SQL = {
  claim: `INSERT INTO platform.idempotency_keys (actor_key, idem_key, endpoint, request_hash, status, created_at, expires_at)
          VALUES ($1, $2, $3, $4, 'IN_FLIGHT', $5, $6)
          ON CONFLICT (actor_key, idem_key) DO UPDATE
            SET endpoint = EXCLUDED.endpoint, request_hash = EXCLUDED.request_hash, status = 'IN_FLIGHT',
                response_status = NULL, response_body = NULL, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
          WHERE platform.idempotency_keys.expires_at <= EXCLUDED.created_at
          RETURNING 1`,
  existing: `SELECT endpoint, request_hash, status, response_status, response_body
               FROM platform.idempotency_keys WHERE actor_key = $1 AND idem_key = $2`,
  complete: `UPDATE platform.idempotency_keys SET status = 'COMPLETED', response_status = $3, response_body = $4
              WHERE actor_key = $1 AND idem_key = $2 AND status = 'IN_FLIGHT'`,
} as const;

/** Claims the key for this request, or returns the stored response to replay. Call first in the transaction. */
export async function beginIdempotent(client: Queryable, req: IdempotencyRequest): Promise<IdempotencyStart> {
  const expires = new Date(req.now.getTime() + (req.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS));
  await client.query(`SET LOCAL lock_timeout = '${IN_FLIGHT_WAIT}'`);
  let claimed: boolean;
  try {
    claimed = (await client.query(SQL.claim, [req.actorKey, req.idemKey, req.endpoint, req.requestHash, req.now, expires])).rows.length === 1;
  } catch (error) {
    // Another open transaction holds the same key: it is still being processed.
    if ((error as { code?: string }).code === '55P03') throw new IdempotencyConflict('IN_PROGRESS');
    throw error;
  }
  if (claimed) return { kind: 'NEW' };
  const row = (await client.query(SQL.existing, [req.actorKey, req.idemKey])).rows[0];
  if (!row) throw new IdempotencyConflict('IN_PROGRESS');
  if (row['endpoint'] !== req.endpoint || !(row['request_hash'] as Buffer).equals(req.requestHash)) throw new IdempotencyConflict('KEY_REUSED');
  if (row['status'] !== 'COMPLETED') throw new IdempotencyConflict('IN_PROGRESS');
  const body = row['response_body'] as Buffer | null;
  return { kind: 'REPLAY', status: row['response_status'] as number, body: body === null ? undefined : JSON.parse(body.toString('utf8')) };
}

/** Stores the response in the same transaction. Bodies must not contain Confidential data (stored as JSON bytes). */
export async function completeIdempotent(client: Queryable, req: Pick<IdempotencyRequest, 'actorKey' | 'idemKey'>, status: number, body: unknown): Promise<void> {
  await client.query(SQL.complete, [req.actorKey, req.idemKey, status, body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')]);
}
