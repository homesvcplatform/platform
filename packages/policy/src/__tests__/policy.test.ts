// Gate 3: policy engine default deny, permission scopes, endpoint registry (B11 / B12), matrix data fidelity.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOW, assertEndpointRegistry, AUTHZ_MATRIX, deny, EndpointRegistryError, hasGlobalPermission, hasPermission, MATRIX_COLUMNS, PolicyRegistry,
  PolicyRegistryError, recentStepUp, type Actor, type DecisionRecord,
} from '../index.ts';

const ctx = { now: new Date('2026-10-09T10:00:00Z') };
const customer: Actor = { kind: 'CUSTOMER', id: 'u1', sessionId: 's1', surface: 'CUSTOMER_WEB' };

describe('policy registry', () => {
  it('denies unknown actions by default and logs every decision', () => {
    const log: DecisionRecord[] = [];
    const r = new PolicyRegistry((d) => log.push(d));
    expect(r.can(customer, 'jobs.job.cancel', {}, ctx)).toEqual({ allow: false, reason: 'NO_POLICY', status: 403 });
    r.define('jobs.job.view', () => ALLOW);
    expect(r.can(customer, 'jobs.job.view', {}, ctx).allow).toBe(true);
    expect(log.map((l) => l.allow)).toEqual([false, true]);
  });

  it('a throwing policy denies; duplicate and malformed actions are refused', () => {
    const r = new PolicyRegistry();
    r.define('a.b', () => { throw new Error('bug'); });
    expect(r.can(customer, 'a.b', {}, ctx)).toMatchObject({ allow: false, reason: 'POLICY_ERROR' });
    expect(() => r.define('a.b', () => ALLOW)).toThrow(PolicyRegistryError);
    expect(() => r.define('Bad Name', () => ALLOW)).toThrow(PolicyRegistryError);
    expect(deny('X', 404)).toEqual({ allow: false, reason: 'X', status: 404 });
  });

  it('admin permissions respect scope and wildcard families; public actors never hold permissions', () => {
    const admin: Actor = {
      kind: 'ADMIN', id: 'a1', permissions: new Map([
        ['jobs.read', [{ kind: 'CITIES', cityIds: ['knl'] }]], ['pii.reveal.*', [{ kind: 'GLOBAL' }]],
      ]),
    };
    expect(hasPermission(admin, 'jobs.read', 'knl')).toBe(true);
    expect(hasPermission(admin, 'jobs.read', 'other-city')).toBe(false);
    expect(hasPermission(admin, 'pii.reveal.address', 'any')).toBe(true);
    expect(hasPermission(admin, 'pii.export')).toBe(false);
    expect(hasPermission({ ...customer, permissions: admin.permissions ?? new Map() }, 'jobs.read')).toBe(false);
  });

  it('hasGlobalPermission accepts only GLOBAL scopes (hasPermission without a city accepts any scope)', () => {
    const admin: Actor = { kind: 'ADMIN', id: 'a2', permissions: new Map([
      ['security.grant', [{ kind: 'CITIES', cityIds: ['knl'] }]], ['audit.read', [{ kind: 'GLOBAL' }]], ['pii.*', [{ kind: 'GLOBAL' }]]]) };
    expect(hasPermission(admin, 'security.grant')).toBe(true); // why security checks must not use it
    expect(hasGlobalPermission(admin, 'security.grant')).toBe(false);
    expect(hasGlobalPermission(admin, 'audit.read')).toBe(true);
    expect(hasGlobalPermission(admin, 'pii.reveal.phone')).toBe(true);
    expect(hasGlobalPermission(customer, 'audit.read')).toBe(false);
  });

  it('step-up freshness', () => {
    const a: Actor = { ...customer, stepUpAt: new Date(ctx.now.getTime() - 4 * 60_000) };
    expect(recentStepUp(a, ctx.now, 5 * 60_000)).toBe(true);
    expect(recentStepUp(a, ctx.now, 3 * 60_000)).toBe(false);
    expect(recentStepUp(customer, ctx.now, 5 * 60_000)).toBe(false);
  });
});

describe('endpoint registry (B11 / B12)', () => {
  it('refuses endpoints without a policy, without an idempotency reason, duplicated or outside the API prefixes', () => {
    const r = new PolicyRegistry();
    r.define('x.y', () => ALLOW);
    expect(() => assertEndpointRegistry([{ method: 'GET', path: '/v1/x', surface: 'public', action: 'x.y', idempotency: 'implicit', rateClass: 'READ' }], r)).not.toThrow();
    try {
      assertEndpointRegistry([
        { method: 'POST', path: '/v1/a', surface: 'public', action: 'missing.policy', idempotency: 'required', rateClass: 'WRITE' },
        { method: 'POST', path: '/v1/b', surface: 'public', action: 'x.y', idempotency: { none: '' }, rateClass: 'WRITE' },
        { method: 'GET', path: '/v1/x', surface: 'public', action: 'x.y', idempotency: 'implicit', rateClass: 'READ' },
        { method: 'GET', path: '/v1/x', surface: 'public', action: 'x.y', idempotency: 'implicit', rateClass: 'READ' },
        { method: 'GET', path: '/internal', surface: 'public', action: 'x.y', idempotency: 'implicit', rateClass: 'READ' },
      ], r);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EndpointRegistryError);
      expect((e as EndpointRegistryError).problems).toHaveLength(4);
    }
  });
});

describe('authorization matrix data', () => {
  it('matches the source table in Phase 1 05 §11 cell for cell', () => {
    const doc = readFileSync(new URL('../../../../docs/phase-1/05-auth-authorization.md', import.meta.url), 'utf8').split('\n');
    const start = doc.findIndex((l) => l.startsWith('| Capability | CUS'));
    const rows = doc.slice(start + 2).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('|')));
    expect(rows).toHaveLength(AUTHZ_MATRIX.length);
    for (const [i, line] of rows.entries()) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      const row = AUTHZ_MATRIX[i];
      expect(row?.capability).toBe(cells[0]);
      for (const [j, col] of MATRIX_COLUMNS.entries()) expect(row?.cells[col], `${cells[0]} / ${col}`).toBe(cells[j + 1]);
    }
  });
});
