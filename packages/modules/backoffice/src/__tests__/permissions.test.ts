// Gate 3: code-defined admin permissions (05 §5.3), seeded role definitions, admin MFA strength, B2 for backoffice SQL.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';
import { ALLOW, PolicyRegistry, type Actor } from '@hsp/policy';
import { BACKOFFICE_SQL, canonicalJson, isKnownPermissionEntry, isPhishingResistant, registerBackofficePolicies } from '../public/index.ts';

const root = new URL('../../../../../', import.meta.url);

describe('permissions', () => {
  it('every permission seeded by the role-definition migration is defined in code', () => {
    const sql = readFileSync(new URL('db/migrations/0027_backoffice__admin_identity.sql', root), 'utf8');
    const block = sql.slice(sql.indexOf('INSERT INTO backoffice.role_permissions'), sql.indexOf('SELECT platform.track_updates'));
    const seeded = [...block.matchAll(/'([a-z][a-z0-9_.*]+)'/g)].map((m) => m[1] ?? '').filter((p) => p.includes('.'));
    expect(seeded.length).toBeGreaterThan(40);
    for (const p of seeded) expect(isKnownPermissionEntry(p), p).toBe(true);
    expect(isKnownPermissionEntry('pii.reveal.*')).toBe(true);
    expect(isKnownPermissionEntry('made.up')).toBe(false);
  });

  it('admins need a phishing-resistant method: SMS / OTP / TOTP / password are refused', () => {
    expect(isPhishingResistant(['hwk', 'user'], undefined)).toBe(true);
    expect(isPhishingResistant(['pwd'], 'phr')).toBe(true);
    for (const amr of [['sms'], ['otp'], ['pwd', 'otp'], ['swk'], [], 'hwk']) expect(isPhishingResistant(amr, undefined), JSON.stringify(amr)).toBe(false);
  });

  it('payload hashing is order-independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
  });
});

describe('backoffice policies', () => {
  const r = new PolicyRegistry();
  registerBackofficePolicies(r);
  const now = new Date('2026-10-09T10:00:00Z');
  const sec = (id: string, extra: Partial<Actor> = {}): Actor => ({ kind: 'ADMIN', id, sessionId: `s-${id}`, permissions: new Map([
    ['security.grant', [{ kind: 'GLOBAL' }]], ['security.grant.approve', [{ kind: 'GLOBAL' }]]]), ...extra });
  const grant = { granteeId: 'g', requesterId: 'm' };

  it('no self-grant; the checker is neither the maker nor the grantee and has a fresh passkey step-up', () => {
    expect(r.can(sec('m'), 'backoffice.grant.request', grant, { now })).toEqual(ALLOW);
    expect(r.can(sec('g'), 'backoffice.grant.request', { granteeId: 'g', requesterId: 'g' }, { now })).toMatchObject({ reason: 'SELF_GRANT' });
    const fresh = { stepUpAt: new Date(now.getTime() - 60_000) };
    expect(r.can(sec('c', fresh), 'backoffice.grant.decide', grant, { now })).toEqual(ALLOW);
    expect(r.can(sec('m', fresh), 'backoffice.grant.decide', grant, { now })).toMatchObject({ reason: 'CHECKER_CONFLICT' });
    expect(r.can(sec('g', fresh), 'backoffice.grant.decide', grant, { now })).toMatchObject({ reason: 'CHECKER_CONFLICT' });
    expect(r.can(sec('c'), 'backoffice.grant.decide', grant, { now })).toMatchObject({ reason: 'STEP_UP_REQUIRED' });
    expect(r.can(sec('c', { stepUpAt: new Date(now.getTime() - 6 * 60_000) }), 'backoffice.grant.decide', grant, { now }))
      .toMatchObject({ reason: 'STEP_UP_REQUIRED' });
    expect(r.can({ kind: 'CUSTOMER', id: 'u' }, 'backoffice.grant.request', { granteeId: 'g', requesterId: 'u' }, { now }).allow).toBe(false);
  });
});

describe('B2: backoffice SQL touches only its own schema and platform', () => {
  it('every statement', () => {
    const spec = JSON.parse(readFileSync(new URL('tools/architecture/modules.json', root), 'utf8'));
    for (const [name, sql] of Object.entries(BACKOFFICE_SQL)) {
      expect(() => assertModuleOwnsSql('backoffice', sql, ownershipFromModulesJson(spec)), name).not.toThrow();
    }
  });
});
