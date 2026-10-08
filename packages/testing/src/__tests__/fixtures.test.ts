// Fixture integrity (no database needed; runs in `pnpm run ci`).
import { describe, expect, it } from 'vitest';
import { GuardrailError } from '@hsp/kernel';
import {
  ADJACENCY, CATEGORIES, CUSTOMERS, LOCALITIES, MATERIALS, must, RATE_CARDS, REPAIR_ITEMS, SERVICE_TYPES, SYMPTOMS, TECHNICIANS, ZONES,
} from '../fixtures/kurnool.ts';
import { blindIndexFixture, decryptFixture, encryptFixture, FIXTURE_KEY_REF, isReservedTestPhone, maskPhone } from '../fixtures/synthetic-crypto.ts';
import { assertSeedAllowed } from '../seed/cli.ts';

const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;

describe('Kurnool fixtures', () => {
  it('match the slice spec (Phase 2 05 §1)', () => {
    expect(ZONES).toHaveLength(2);
    expect(LOCALITIES).toHaveLength(12);
    expect(CATEGORIES.map((c) => c.code)).toEqual(['PLUMBING', 'ELECTRICAL', 'APPLIANCE_HOME_EQUIPMENT']);
    expect(TECHNICIANS.map((t) => t.key)).toEqual(['T-PLB-1', 'T-PLB-2', 'T-ELE-1', 'T-FRG-1', 'T-FRG-2', 'T-RO-1', 'T-AC-1']);
    expect(CUSTOMERS.map((c) => c.key)).toEqual(['C-1', 'C-2', 'C-3', 'C-4']);
    expect(TECHNICIANS.find((t) => t.key === 'T-ELE-1')?.deviceMode).toBe('BASIC_PHONE');
    expect(TECHNICIANS.find((t) => t.key === 'T-FRG-1')?.specializations).not.toContain('GAS_REFRIGERATION');
    expect(TECHNICIANS.find((t) => t.key === 'T-FRG-2')?.specializations).toEqual(['GAS_REFRIGERATION']);
  });

  it('have unique codes and IDs', () => {
    expect(unique(SERVICE_TYPES.map((t) => t.code))).toBe(true);
    expect(unique(REPAIR_ITEMS.map((r) => r.code))).toBe(true);
    expect(unique(MATERIALS.map((m) => m.code))).toBe(true);
    expect(unique(LOCALITIES.map((l) => l.id))).toBe(true);
    expect(unique([...TECHNICIANS.map((t) => t.userId), ...CUSTOMERS.map((c) => c.userId)])).toBe(true);
    expect(unique(SYMPTOMS.map((s) => `${s.serviceType}/${s.code}`))).toBe(true);
  });

  it('scope IVR keypad codes per service type and only reference known specializations', () => {
    const pairs = REPAIR_ITEMS.map((r) => `${r.serviceType}/${r.keypad}`);
    expect(unique(pairs)).toBe(true);
    for (const r of REPAIR_ITEMS) {
      const type = must(SERVICE_TYPES.find((t) => t.code === r.serviceType), r.serviceType);
      if (r.specialization) expect(type.specializations, r.code).toContain(r.specialization);
    }
    for (const t of TECHNICIANS) {
      const type = must(SERVICE_TYPES.find((s) => s.code === t.serviceType), t.serviceType);
      for (const s of t.specializations) expect(type.specializations, t.key).toContain(s);
    }
  });

  it('use only reserved fake phone numbers', () => {
    for (const p of [...TECHNICIANS.map((t) => t.phone), ...CUSTOMERS.map((c) => c.phone)]) expect(isReservedTestPhone(p), p).toBe(true);
    expect(isReservedTestPhone('+919876543210')).toBe(false);
  });

  it('label fixture rate cards as not final and keep exactly one active', () => {
    for (const card of RATE_CARDS) expect(card.label).toMatch(/_FIXTURE_NOT_FINAL$/);
    expect(RATE_CARDS.filter((c) => c.status === 'ACTIVE')).toHaveLength(1);
  });

  it('builds a symmetric adjacency graph without self-loops', () => {
    for (const e of ADJACENCY) {
      expect(e.from).not.toBe(e.to);
      expect(ADJACENCY.some((r) => r.from === e.to && r.to === e.from)).toBe(true);
    }
  });
});

describe('fixture crypto', () => {
  it('round-trips the documented envelope format', () => {
    const env = encryptFixture('House 1, Test Street A');
    expect(env[0]).toBe(1);
    expect(env.subarray(2, 2 + (env[1] ?? 0)).toString()).toBe(FIXTURE_KEY_REF);
    expect(decryptFixture(env)).toBe('House 1, Test Street A');
    expect(encryptFixture('x').equals(encryptFixture('x'))).toBe(false);
  });

  it('detects tampering', () => {
    const env = encryptFixture('secret-ish synthetic');
    env[env.length - 20] = (env[env.length - 20] ?? 0) ^ 0xff;
    expect(() => decryptFixture(env)).toThrow();
  });

  it('derives stable 16-byte blind indexes and masks phones', () => {
    expect(blindIndexFixture('+910000000101')).toHaveLength(16);
    expect(blindIndexFixture(' +910000000101 ').equals(blindIndexFixture('+910000000101'))).toBe(true);
    expect(maskPhone('+910000000101')).toBe('+91 00•••••01');
  });
});

describe('seed guard', () => {
  it('refuses production markers and non-seedable environments', () => {
    expect(() => assertSeedAllowed({ APP_ENV: 'production' })).toThrow(GuardrailError);
    expect(() => assertSeedAllowed({ APP_ENV: 'staging' })).toThrow(/local, dev or test/);
    expect(() => assertSeedAllowed({ APP_ENV: 'test', PROD_DATABASE_URL: 'x' })).toThrow(GuardrailError);
    expect(() => assertSeedAllowed({ APP_ENV: 'local' })).not.toThrow();
  });
});
