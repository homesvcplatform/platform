// Gate 4: service-rule validation and resolution (ADR-025 #7), catalog policies, SQL ownership (B2).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';
import { PolicyRegistry } from '@hsp/policy';
import { CATALOG_SQL, effectiveRule, parseServiceRules, registerCatalogPolicies } from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));

describe('service rules schema', () => {
  it('accepts the seeded shape and a minimal rule', () => {
    expect(parseServiceRules({ enabled: true, same_visit_repair_allowed: true, quote_expiry_hours: 48, min_verification_level: 1, fixture: 'NOT_FINAL' }).ok).toBe(true);
    expect(parseServiceRules({ enabled: false }).ok).toBe(true);
  });

  it.each([
    ['missing enabled', { same_visit_repair_allowed: true }],
    ['enabled as text', { enabled: 'true' }],
    ['unknown key (typo)', { enabled: true, enabeld: false }],
    ['quote expiry out of range', { enabled: true, quote_expiry_hours: 0 }],
    ['fractional level', { enabled: true, min_verification_level: 1.5 }],
    ['not an object', ['enabled']],
    ['null', null],
    ['non-fixture marker', { enabled: true, fixture: 'FINAL' }],
  ])('refuses %s', (_label, value) => expect(parseServiceRules(value).ok).toBe(false));
});

describe('rule resolution', () => {
  it('a city rule replaces the default; no rule means not offered', () => {
    expect(effectiveRule({ enabled: false }, { enabled: true })).toEqual({ enabled: false });
    expect(effectiveRule(undefined, { enabled: true })).toEqual({ enabled: true });
    expect(effectiveRule(undefined, undefined)).toBeUndefined();
  });
});

describe('catalog policies', () => {
  it('service discovery is anonymous by design', () => {
    const r = new PolicyRegistry();
    registerCatalogPolicies(r);
    for (const action of ['catalog.categories.list', 'catalog.symptoms.list']) expect(r.can({ kind: 'ANONYMOUS' }, action, {}, { now: new Date() }).allow).toBe(true);
  });
});

describe('B2: catalog SQL touches only its own schema', () => {
  it('every statement', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(CATALOG_SQL)) expect(() => assertModuleOwnsSql('catalog', sql, ownership), name).not.toThrow();
  });
});
