// Pure lifecycle rules: stage-gated disclosure (02 §5, G-4, X-30), cancellation stage (06 §10), booking windows,
// public references. No I/O; the application service supplies the facts.
import { randomInt } from 'node:crypto';
import type { LifecyclePolicy } from './policy.ts';
import type { AssignmentStatus, VisitStatus } from './transitions.ts';

export type DisclosureLevel = 'NONE' | 'L1' | 'L2' | 'L3';

export interface DisclosureFacts {
  /** The asking technician's most recent assignment on this visit (none = no access at all). */
  readonly assignment: { readonly status: AssignmentStatus; readonly acceptedAt: Date; readonly endedAt: Date | null } | null;
  readonly visit: { readonly status: VisitStatus; readonly windowStart: Date; readonly terminalAt: Date | null };
  /** OTP-verified booking, or ops confirmed it by a call to the registered number (G-4). */
  readonly customerVerified: boolean;
  readonly now: Date;
}

export interface Disclosure {
  readonly level: DisclosureLevel;
  /** When L2 opens / closes for this assignment (null = not yet known). */
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
}

const TERMINAL_VISIT = new Set<VisitStatus>(['COMPLETED', 'CANCELLED', 'CUSTOMER_NO_SHOW', 'ABORTED']);

/**
 * L1 while the assignment is ACTIVE before the window opens (or while the customer is unverified); L2 from
 * max(accepted, window start − lead) to visit terminal + close-after, only for a verified customer, and only for an
 * ACTIVE assignment or one that ended with the visit (COMPLETED); L3 afterwards for 30 days (X-30). A released,
 * revoked or no-show technician drops to L3 at once. Never L2 after the window (X-30).
 */
export function disclosure(f: DisclosureFacts, p: LifecyclePolicy): Disclosure {
  const a = f.assignment;
  if (!a) return { level: 'NONE', opensAt: null, closesAt: null };
  const opensAt = new Date(Math.max(a.acceptedAt.getTime(), f.visit.windowStart.getTime() - p.disclosureOpenLeadMs));
  const terminalAt = TERMINAL_VISIT.has(f.visit.status) ? (f.visit.terminalAt ?? a.endedAt ?? f.now) : null;
  const closesAt = terminalAt ? new Date(terminalAt.getTime() + p.disclosureCloseAfterMs) : null;
  const now = f.now.getTime();
  const endedAt = a.endedAt?.getTime() ?? null;
  const l3 = (): Disclosure => (endedAt !== null && now > endedAt + p.l3RetentionMs
    ? { level: 'NONE', opensAt, closesAt } : { level: 'L3', opensAt, closesAt });
  // Only the ACTIVE assignment, or the one that ended with the visit (COMPLETED), keeps L1 / L2; a technician released,
  // revoked or marked no-show drops to L3 at once.
  if (a.status !== 'ACTIVE' && endedAt !== null && now > endedAt + p.l3RetentionMs) return { level: 'NONE', opensAt, closesAt };
  if (a.status !== 'ACTIVE' && a.status !== 'COMPLETED') return l3();
  if (a.status === 'COMPLETED' && (closesAt === null || now >= closesAt.getTime())) return l3();
  if (closesAt !== null && now >= closesAt.getTime()) return l3();
  if (now >= opensAt.getTime() && f.customerVerified) return { level: 'L2', opensAt, closesAt };
  return { level: 'L1', opensAt, closesAt };
}

export type CancellationStage = 'BEFORE_ASSIGNMENT' | 'ASSIGNED_FREE' | 'ASSIGNED_LATE' | 'EN_ROUTE' | 'NOT_CANCELLABLE';

/** 06 §10 rows reachable in Gate 5 (before a quote exists). */
export function cancellationStage(visit: { status: VisitStatus; windowStart: Date }, now: Date, freeCancelLeadMs: number): CancellationStage {
  switch (visit.status) {
    case 'PLANNED': case 'MATCHING': case 'UNFULFILLED': return 'BEFORE_ASSIGNMENT';
    case 'ASSIGNED': return now.getTime() < visit.windowStart.getTime() - freeCancelLeadMs ? 'ASSIGNED_FREE' : 'ASSIGNED_LATE';
    case 'EN_ROUTE': return 'EN_ROUTE';
    default: return 'NOT_CANCELLABLE';
  }
}

/** The service window for a booking: ASAP = [now, now + asap window); a slot must fit the fixture slot grid. */
export function bookingWindow(timing: { type: 'ASAP' } | { type: 'SLOT'; start: Date; end: Date }, now: Date, p: LifecyclePolicy):
  { start: Date; end: Date; urgency: 'ASAP' | 'SCHEDULED' } | null {
  if (timing.type === 'ASAP') return { start: now, end: new Date(now.getTime() + p.asapWindowMs), urgency: 'ASAP' };
  const s = timing.start.getTime();
  const e = timing.end.getTime();
  const length = e - s;
  if (!Number.isFinite(s) || !Number.isFinite(e) || length < p.slotMinMs || length > p.slotMaxMs) return null;
  if (s % p.slotStepMs !== 0 || e % p.slotStepMs !== 0) return null;
  if (s < now.getTime() + p.matchLeadMs || s > now.getTime() + p.slotMaxAheadMs) return null;
  return { start: timing.start, end: timing.end, urgency: 'SCHEDULED' };
}

/** When matching starts for a visit (06 §3 PLANNED): ASAP now, scheduled at window start − lead. */
export function matchStartAt(window: { start: Date }, urgency: 'ASAP' | 'SCHEDULED', now: Date, p: LifecyclePolicy): Date {
  return urgency === 'ASAP' ? now : new Date(Math.max(now.getTime(), window.start.getTime() - p.matchLeadMs));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `J-` + 6 random Crockford Base32 characters + 1 check character (03 §1). */
export function newPublicRef(): string {
  let body = '';
  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    const v = randomInt(32);
    body += CROCKFORD[v];
    sum += v * (i + 1);
  }
  return `J-${body}${CROCKFORD[sum % 32]}`;
}

export function isValidPublicRef(ref: string): boolean {
  const m = /^J-([0-9A-HJKMNP-TV-Z]{6})([0-9A-HJKMNP-TV-Z])$/.exec(ref);
  if (!m?.[1] || !m[2]) return false;
  const sum = [...m[1]].reduce((acc, ch, i) => acc + CROCKFORD.indexOf(ch) * (i + 1), 0);
  return CROCKFORD[sum % 32] === m[2];
}
