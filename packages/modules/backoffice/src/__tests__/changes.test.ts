// Gate 4 (ADR-025 #5–#6): change-action registry checks and the maker / checker policies for change requests.
import { describe, expect, it } from 'vitest';
import { PolicyRegistry, type Actor, type Scope } from '@hsp/policy';
import { changeActionRegistry, registerBackofficePolicies, STEP_UP_OPERATIONS, type ChangeAction } from '../public/index.ts';

const action = (over: Partial<ChangeAction> = {}): ChangeAction => ({
  actionType: 'catalog.service_rules.set', resourceType: 'catalog.service_type', makerPermission: 'service_rules.edit',
  checkerPermission: 'service_rules.approve', riskLevel: 'MEDIUM',
  prepare: async () => ({ payload: {}, resourceId: null, cityId: null, summary: {} }), cityOf: () => null, execute: async () => undefined,
  ...over,
});

describe('change action registry (boot-time)', () => {
  it('accepts well-formed actions', () => {
    expect([...changeActionRegistry([action(), action({ actionType: 'geo.city.locales.set', makerPermission: 'locales.enable', checkerPermission: 'locales.approve' })]).keys()])
      .toEqual(['catalog.service_rules.set', 'geo.city.locales.set']);
  });

  it.each([
    ['duplicate type', [action(), action()]],
    ['security namespace (role grants keep their own path)', [action({ actionType: 'security.grant' })]],
    ['malformed type', [action({ actionType: 'Catalog Rules' })]],
    ['unknown permission', [action({ makerPermission: 'catalog.anything' })]],
    ['maker = checker permission', [action({ checkerPermission: 'service_rules.edit' })]],
  ])('refuses %s', (_label, actions) => expect(() => changeActionRegistry(actions)).toThrow());
});

describe('change request policies', () => {
  const r = new PolicyRegistry();
  registerBackofficePolicies(r);
  const ctx = { now: new Date() };
  const admin = (id: string, perms: Record<string, Scope[]>): Actor => ({ kind: 'ADMIN', id, sessionId: `s-${id}`, permissions: new Map(Object.entries(perms)) });
  const city = (...cityIds: string[]): Scope[] => [{ kind: 'CITIES', cityIds }];
  const pricing = admin('maker', { 'service_rules.edit': city('c1') });
  const manager = admin('checker', { 'service_rules.approve': city('c1') });

  it('maker needs the maker permission for the change city; all-city changes need a GLOBAL grant', () => {
    expect(r.can(pricing, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: undefined, requesterId: 'maker' }, ctx).allow).toBe(true);
    expect(r.can(pricing, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: 'c1', requesterId: 'maker' }, ctx).allow).toBe(true);
    expect(r.can(pricing, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: 'c2', requesterId: 'maker' }, ctx).allow).toBe(false);
    expect(r.can(pricing, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: null, requesterId: 'maker' }, ctx).allow).toBe(false);
    expect(r.can(admin('g', { 'service_rules.edit': [{ kind: 'GLOBAL' }] }), 'backoffice.change.request',
      { permission: 'service_rules.edit', cityId: null, requesterId: 'g' }, ctx).allow).toBe(true);
    expect(r.can(manager, 'backoffice.change.request', { permission: 'service_rules.edit', cityId: 'c1', requesterId: 'checker' }, ctx).allow).toBe(false);
  });

  it('checker needs the checker permission for the city and is never the maker (INV-19)', () => {
    expect(r.can(manager, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: 'c1', requesterId: 'maker' }, ctx).allow).toBe(true);
    expect(r.can(manager, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: 'c2', requesterId: 'maker' }, ctx).allow).toBe(false);
    expect(r.can(manager, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: 'c1', requesterId: 'checker' }, ctx).allow).toBe(false);
    const both = admin('both', { 'service_rules.edit': city('c1'), 'service_rules.approve': city('c1') });
    expect(r.can(both, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: 'c1', requesterId: 'both' }, ctx).allow).toBe(false);
    expect(r.can({ kind: 'ANONYMOUS' }, 'backoffice.change.decide', { permission: 'service_rules.approve', cityId: 'c1', requesterId: 'maker' }, ctx).allow).toBe(false);
  });

  it('change decisions have their own bound step-up operation', () => {
    expect(STEP_UP_OPERATIONS).toContain('backoffice.change.decide');
  });
});
