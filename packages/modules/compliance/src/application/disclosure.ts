// Disclosure log (Phase 1 02 §5, INV-17): every L2 access to an exact address, masked call or problem media is
// recorded in the restricted compliance.disclosure_events table, never in application logs.
import type { Queryable } from '@hsp/db';
import { newId } from '@hsp/kernel';

export const COMPLIANCE_SQL = {
  insertDisclosure: `INSERT INTO compliance.disclosure_events (id, visit_id, viewer_type, viewer_id, data_kind, channel, call_session_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
} as const;

export interface DisclosureEvent {
  readonly visitId: string;
  readonly viewerType: 'TECHNICIAN' | 'FIELD_AGENT' | 'ADMIN' | 'SYSTEM';
  readonly viewerId: string;
  readonly dataKind: 'EXACT_ADDRESS' | 'MASKED_CALL' | 'PROBLEM_MEDIA' | 'ACCESS_NOTES';
  readonly channel: 'APP' | 'IVR' | 'ADMIN_CONSOLE' | 'AGENT_WEB';
  readonly callSessionId?: string | null;
}

export async function recordDisclosure(q: Queryable, e: DisclosureEvent): Promise<void> {
  await q.query(COMPLIANCE_SQL.insertDisclosure, [newId(), e.visitId, e.viewerType, e.viewerId, e.dataKind, e.channel, e.callSessionId ?? null]);
}
