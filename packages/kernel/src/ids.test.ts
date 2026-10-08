import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.ts';
import { fixtureId, isUuidV7, newId } from './ids.ts';

describe('ids', () => {
  it('generates distinct, time-ordered UUIDv7 values', () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(isUuidV7(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('derives stable fixture IDs per (namespace, name)', () => {
    expect(fixtureId('geo.cities', 'KNL')).toBe(fixtureId('geo.cities', 'KNL'));
    expect(fixtureId('geo.cities', 'KNL')).not.toBe(fixtureId('geo.cities', 'KNL2'));
    expect(fixtureId('geo.cities', 'KNL')).not.toBe(fixtureId('geo.zones', 'KNL'));
    expect(isUuidV7(fixtureId('x', 'y'))).toBe(true);
  });
});

describe('ManualClock', () => {
  it('moves only forward', () => {
    const clock = new ManualClock(new Date('2026-01-01T00:00:00Z'));
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});
