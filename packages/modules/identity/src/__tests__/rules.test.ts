// Gate 3: identity rules (Phase 1 05 §2–§4, SR-14, X-14, X-32) and the identity policies (matrix "Revoke sessions").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PolicyRegistry, type Actor } from '@hsp/policy';
import {
  IDENTITY_SQL, maskPhone, newDeviceApprovalHold, newDevicePayoutHold, phoneAllowed, pinRejectionReason, registerIdentityPolicies,
  SESSION_POLICY, surfaceUsesBearerTokens,
} from '../public/index.ts';
import { sessionCookieHeader } from '../domain/rules.ts';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));

describe('identity rules', () => {
  it('Phase 2 accepts only the reserved fake phone range (no real PII)', () => {
    expect(phoneAllowed('+910000000101', 'RESERVED_TEST_RANGE_ONLY')).toBe(true);
    expect(phoneAllowed('+919876543210', 'RESERVED_TEST_RANGE_ONLY')).toBe(false);
    expect(phoneAllowed('+919876543210', 'INDIAN_MOBILE')).toBe(true);
    expect(phoneAllowed('+910000000101', 'INDIAN_MOBILE')).toBe(false);
    expect(maskPhone('+910000000101')).toBe('+91 ••••• •••01');
  });

  it.each([['0000', 'REPEATED'], ['7777', 'REPEATED'], ['1234', 'SEQUENCE'], ['9876', 'SEQUENCE'], ['1990', 'YEAR'], ['2024', 'YEAR'],
    ['12a4', 'FORMAT'], ['12345', 'FORMAT']])('rejects trivial PIN %s (%s)', (pin, reason) => {
    expect(pinRejectionReason(pin)).toBe(reason);
  });

  it.each(['2580', '7319', '0471'])('accepts PIN %s', (pin) => expect(pinRejectionReason(pin)).toBeUndefined());

  it('X-14 / SR-02: only the technician app uses bearer tokens; agent web uses BFF cookie sessions', () => {
    expect(surfaceUsesBearerTokens('TECHNICIAN_APP')).toBe(true);
    expect(surfaceUsesBearerTokens('AGENT_WEB')).toBe(false);
    expect(surfaceUsesBearerTokens('CUSTOMER_WEB')).toBe(false);
    expect(SESSION_POLICY.AGENT_WEB).toEqual({ idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
  });

  it('session cookie carries __Host-, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', () => {
    const c = sessionCookieHeader('abc', 100);
    expect(c).toMatch(/^__Host-sid=abc; /);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(c).toContain(flag);
    expect(c.toLowerCase()).not.toContain('domain=');
  });

  it('SR-14: a high-value approval from a device first seen < 24 h ago is held', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    const fresh = new Date(now.getTime() - 3 * 3_600_000);
    const old = new Date(now.getTime() - 25 * 3_600_000);
    expect(newDeviceApprovalHold({ deviceFirstSeenAt: fresh, now, amountPaise: 300_000, thresholdPaise: 200_000 })).toBe(true);
    expect(newDeviceApprovalHold({ deviceFirstSeenAt: fresh, now, amountPaise: 100_000, thresholdPaise: 200_000 })).toBe(false);
    expect(newDeviceApprovalHold({ deviceFirstSeenAt: old, now, amountPaise: 300_000, thresholdPaise: 200_000 })).toBe(false);
  });

  it('X-32: a new device alone never holds payouts', () => {
    expect(newDevicePayoutHold({ newDevice: true, payoutMethodChanged: false, integrityVerdict: 'MEETS_DEVICE' })).toBe(false);
    expect(newDevicePayoutHold({ newDevice: true, payoutMethodChanged: true, integrityVerdict: 'MEETS_DEVICE' })).toBe(true);
    expect(newDevicePayoutHold({ newDevice: true, payoutMethodChanged: false, integrityVerdict: 'FAILED' })).toBe(true);
    expect(newDevicePayoutHold({ newDevice: false, payoutMethodChanged: true, integrityVerdict: 'FAILED' })).toBe(false);
  });
});

describe('identity policies', () => {
  const r = new PolicyRegistry();
  registerIdentityPolicies(r);
  const ctx = { now: new Date() };
  const me: Actor = { kind: 'CUSTOMER', id: 'u1', sessionId: 's1', surface: 'CUSTOMER_WEB' };

  it('own sessions only (404 for others); IVR cannot revoke; admins need the permission globally and a reason (R12)', () => {
    expect(r.can(me, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: null }, ctx).allow).toBe(true);
    expect(r.can(me, 'identity.session.revoke', { ownerUserId: 'u2', reasonCode: null }, ctx)).toMatchObject({ allow: false, status: 404 });
    expect(r.can({ ...me, kind: 'TECHNICIAN', surface: 'TECHNICIAN_IVR' }, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: null }, ctx).allow).toBe(false);
    const sec: Actor = { kind: 'ADMIN', id: 'a1', sessionId: 'as1', permissions: new Map([['security.sessions.revoke', [{ kind: 'GLOBAL' }]]]) };
    expect(r.can(sec, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: 'ACCOUNT_COMPROMISE' }, ctx).allow).toBe(true);
    expect(r.can(sec, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: null }, ctx).allow).toBe(false);
    expect(r.can({ ...sec, permissions: new Map() }, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: 'X' }, ctx).allow).toBe(false);
    const cityScoped: Actor = { ...sec, permissions: new Map([['security.sessions.revoke', [{ kind: 'CITIES', cityIds: ['c1'] }]]]) };
    expect(r.can(cityScoped, 'identity.session.revoke', { ownerUserId: 'u1', reasonCode: 'ACCOUNT_COMPROMISE' }, ctx).allow).toBe(false);
    expect(r.can({ kind: 'ANONYMOUS' }, 'identity.session.list', {}, ctx).allow).toBe(false);
  });
});

describe('B2: identity SQL touches only its own schema and platform', () => {
  it('every statement', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(IDENTITY_SQL)) expect(() => assertModuleOwnsSql('identity', sql, ownership), name).not.toThrow();
  });
});
