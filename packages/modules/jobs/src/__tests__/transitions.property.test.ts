// Gate 5 exit criterion "property tests over transition tables (no illegal transition reachable)", plus properties of
// the disclosure rule (INV-17, G-4, X-30) and booking windows. fast-check (ADR-026 #4).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions, assertTransition, bookingWindow, canTransition, cancellationStage, disclosure, FIXTURE_LIFECYCLE_POLICY as P,
  InvalidTransitionError, isTerminal, isValidPublicRef, MACHINES, newPublicRef, statesOf, type Machine,
} from '../public/index.ts';

const machines = Object.keys(MACHINES) as Machine[];
const RUNS = { numRuns: 500 };

describe('transition tables', () => {
  it.each(machines)('%s: a random walk using only allowed moves stays inside the table and stops only in terminal states', (m) => {
    const states = statesOf(m);
    fc.assert(fc.property(fc.constantFrom(...MACHINES[m].initial), fc.array(fc.nat(), { maxLength: 40 }), (start, picks) => {
      let state: string = start;
      for (const pick of picks) {
        const next = (MACHINES[m].transitions as Record<string, readonly string[]>)[state] ?? [];
        if (next.length === 0) {
          expect(isTerminal(m, state)).toBe(true);
          return;
        }
        const to = next[pick % next.length] ?? state;
        assertTransition(m, state, to);
        state = to;
        expect(states).toContain(state);
      }
    }), RUNS);
  });

  it.each(machines)('%s: any move not in the table is refused', (m) => {
    const states = statesOf(m);
    fc.assert(fc.property(fc.constantFrom(...states, 'BOGUS', ''), fc.constantFrom(...states, 'BOGUS', ''), (from, to) => {
      const allowed = allowedTransitions().some((t) => t.machine === m && t.from === from && t.to === to);
      expect(canTransition(m, from, to)).toBe(allowed);
      if (!allowed) expect(() => assertTransition(m, from, to)).toThrow(InvalidTransitionError);
    }), RUNS);
  });

  it.each(machines)('%s: every state is reachable from an initial state, terminals have no exits, no self-loops', (m) => {
    const t = MACHINES[m].transitions as Record<string, readonly string[]>;
    const seen = new Set<string>(MACHINES[m].initial);
    const queue: string[] = [...MACHINES[m].initial];
    while (queue.length > 0) for (const next of t[queue.shift() ?? ''] ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    expect([...seen].sort()).toEqual(statesOf(m).sort());
    for (const [from, tos] of Object.entries(t)) expect(tos).not.toContain(from);
  });

  it('specific forbidden moves from 06 stay forbidden', () => {
    for (const [m, from, to] of [
      ['job', 'REQUESTED', 'AWAITING_APPROVAL'], ['job', 'REQUESTED', 'CLOSED'], ['job', 'IN_DIAGNOSIS', 'REPAIR_PENDING'],
      ['job', 'AWAITING_PAYMENT', 'REPAIR_IN_PROGRESS'], ['job', 'CLOSED', 'REQUESTED'], ['job', 'REPAIR_IN_PROGRESS', 'CANCELLED'],
      ['visit', 'PLANNED', 'ASSIGNED'], ['visit', 'MATCHING', 'EN_ROUTE'], ['visit', 'UNFULFILLED', 'ASSIGNED'], ['visit', 'ASSIGNED', 'ON_SITE'],
      ['visit', 'EN_ROUTE', 'COMPLETED'], ['visit', 'IN_PROGRESS', 'CANCELLED'], ['visit', 'ON_SITE', 'CANCELLED'],
      ['assignment', 'RELEASED', 'ACTIVE'], ['repair_order', 'AWAITING_SCHEDULE', 'COMPLETED'], ['repair_order', 'COMPLETED', 'IN_PROGRESS'],
    ] as const) expect(canTransition(m, from, to), `${m} ${from} → ${to}`).toBe(false);
  });
});

describe('disclosure (INV-17, G-4, X-30)', () => {
  const H = 3_600_000;
  const facts = fc.record({
    status: fc.constantFrom('ACTIVE', 'COMPLETED', 'RELEASED', 'NO_SHOW', 'REVOKED'),
    visitStatus: fc.constantFrom('ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CUSTOMER_NO_SHOW', 'ABORTED', 'MATCHING'),
    verified: fc.boolean(),
    acceptedOffset: fc.integer({ min: -72, max: 0 }),
    windowOffset: fc.integer({ min: -72, max: 72 }),
    terminalOffset: fc.integer({ min: -800, max: 24 }),
    endedOffset: fc.integer({ min: -800, max: 0 }),
  });

  it('never L2 for an unverified customer, before the window opens, after it closes, or for a released / revoked technician', () => {
    fc.assert(fc.property(facts, (f) => {
      const now = new Date('2026-10-09T12:00:00Z');
      const at = (h: number) => new Date(now.getTime() + h * H);
      const ended = f.status === 'ACTIVE' ? null : at(f.endedOffset);
      const terminal = ['COMPLETED', 'CANCELLED', 'CUSTOMER_NO_SHOW', 'ABORTED'].includes(f.visitStatus) ? at(Math.min(f.terminalOffset, 0)) : null;
      const d = disclosure({ assignment: { status: f.status, acceptedAt: at(f.acceptedOffset), endedAt: ended },
        visit: { status: f.visitStatus, windowStart: at(f.windowOffset), terminalAt: terminal }, customerVerified: f.verified, now }, P);
      if (d.level === 'L2') {
        expect(f.verified).toBe(true);
        expect(['ACTIVE', 'COMPLETED']).toContain(f.status);
        expect(now.getTime()).toBeGreaterThanOrEqual(d.opensAt?.getTime() ?? Infinity);
        if (d.closesAt) expect(now.getTime()).toBeLessThan(d.closesAt.getTime());
      }
      if (f.status === 'RELEASED' || f.status === 'REVOKED' || f.status === 'NO_SHOW') expect(['L3', 'NONE']).toContain(d.level);
      if (ended && now.getTime() > ended.getTime() + P.l3RetentionMs) expect(d.level).toBe('NONE');
    }), { numRuns: 2000 });
  });

  it('no assignment means no access', () => {
    expect(disclosure({ assignment: null, visit: { status: 'ASSIGNED', windowStart: new Date(), terminalAt: null }, customerVerified: true, now: new Date() }, P).level)
      .toBe('NONE');
  });

  it('a verified, active assignment opens L2 exactly at max(accepted, window start − 3 h)', () => {
    const accepted = new Date('2026-10-09T06:00:00Z');
    const windowStart = new Date('2026-10-09T12:00:00Z');
    const base = { assignment: { status: 'ACTIVE' as const, acceptedAt: accepted, endedAt: null },
      visit: { status: 'ASSIGNED' as const, windowStart, terminalAt: null }, customerVerified: true };
    expect(disclosure({ ...base, now: new Date('2026-10-09T08:59:59Z') }, P).level).toBe('L1');
    expect(disclosure({ ...base, now: new Date('2026-10-09T09:00:00Z') }, P).level).toBe('L2');
    expect(disclosure({ ...base, customerVerified: false, now: new Date('2026-10-09T10:00:00Z') }, P).level).toBe('L1');
  });
});

describe('booking rules', () => {
  const now = new Date('2026-10-09T06:00:00Z');
  it('ASAP windows start now; slots must fit the fixture grid and lead', () => {
    expect(bookingWindow({ type: 'ASAP' }, now, P)).toMatchObject({ urgency: 'ASAP', start: now });
    expect(bookingWindow({ type: 'SLOT', start: new Date('2026-10-09T10:00:00Z'), end: new Date('2026-10-09T12:00:00Z') }, now, P)?.urgency).toBe('SCHEDULED');
    expect(bookingWindow({ type: 'SLOT', start: new Date('2026-10-09T07:00:00Z'), end: new Date('2026-10-09T09:00:00Z') }, now, P)).toBeNull(); // inside the lead
    expect(bookingWindow({ type: 'SLOT', start: new Date('2026-10-09T10:10:00Z'), end: new Date('2026-10-09T12:10:00Z') }, now, P)).toBeNull(); // off grid
    expect(bookingWindow({ type: 'SLOT', start: new Date('2026-10-09T10:00:00Z'), end: new Date('2026-10-09T18:00:00Z') }, now, P)).toBeNull(); // too long
    expect(bookingWindow({ type: 'SLOT', start: new Date('2026-10-30T10:00:00Z'), end: new Date('2026-10-30T12:00:00Z') }, now, P)).toBeNull(); // too far
  });

  it('cancellation stages follow 06 §10', () => {
    const w = new Date('2026-10-09T12:00:00Z');
    expect(cancellationStage({ status: 'MATCHING', windowStart: w }, now, 2 * 3_600_000)).toBe('BEFORE_ASSIGNMENT');
    expect(cancellationStage({ status: 'ASSIGNED', windowStart: w }, now, 2 * 3_600_000)).toBe('ASSIGNED_FREE');
    expect(cancellationStage({ status: 'ASSIGNED', windowStart: w }, new Date('2026-10-09T10:30:00Z'), 2 * 3_600_000)).toBe('ASSIGNED_LATE');
    expect(cancellationStage({ status: 'EN_ROUTE', windowStart: w }, now, 0)).toBe('EN_ROUTE');
    for (const s of ['ON_SITE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const) expect(cancellationStage({ status: s, windowStart: w }, now, 0)).toBe('NOT_CANCELLABLE');
  });

  it('public references carry a valid check character', () => {
    fc.assert(fc.property(fc.constant(null), () => {
      expect(isValidPublicRef(newPublicRef())).toBe(true);
    }), { numRuns: 200 });
    expect(isValidPublicRef('J-0000000')).toBe(true);
    expect(isValidPublicRef('J-0000001')).toBe(false);
  });
});
