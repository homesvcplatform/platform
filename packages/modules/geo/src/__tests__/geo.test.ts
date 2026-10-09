// Gate 4: geo domain rules (normalisation, India bounding box, shortest travel) and SQL ownership (B2).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';
import { PolicyRegistry } from '@hsp/policy';
import { GEO_SQL, isInIndia, normalizeSearchText, registerGeoPolicies, shortestTravel } from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));

describe('search text normalisation', () => {
  it('folds case and punctuation, keeps Telugu vowel signs, NFC', () => {
    expect(normalizeSearchText('  Test-Nagar,  No.3 ')).toBe('test nagar no 3');
    expect(normalizeSearchText('టెస్ట్ నగర్')).toBe('టెస్ట్ నగర్');
    expect(normalizeSearchText('Café')).toBe('café');
  });
});

describe('India bounding box', () => {
  it('accepts Kurnool, refuses outside India and non-finite values', () => {
    expect(isInIndia({ lat: 15.83, lng: 78.04 })).toBe(true);
    expect(isInIndia({ lat: 51.5, lng: -0.12 })).toBe(false);
    expect(isInIndia({ lat: Number.NaN, lng: 78 })).toBe(false);
  });
});

describe('shortest travel', () => {
  const edges = [
    { from: 'a', to: 'b', minutes: 10 }, { from: 'b', to: 'a', minutes: 10 },
    { from: 'b', to: 'c', minutes: 15 }, { from: 'c', to: 'b', minutes: 15 },
    { from: 'a', to: 'c', minutes: 40 },
  ];
  it('takes the cheaper multi-hop path', () => expect(shortestTravel(edges, 'a', 'c')).toEqual({ minutes: 25, hops: 2 }));
  it('respects edge direction', () => expect(shortestTravel(edges, 'c', 'a')).toEqual({ minutes: 25, hops: 2 }));
  it('same locality is zero', () => expect(shortestTravel([], 'x', 'x')).toEqual({ minutes: 0, hops: 0 }));
  it('unreachable is null', () => expect(shortestTravel(edges, 'a', 'z')).toBeNull());
});

describe('geo policies', () => {
  it('public reads are anonymous by design', () => {
    const r = new PolicyRegistry();
    registerGeoPolicies(r);
    for (const action of ['geo.localities.search', 'geo.serviceability.check']) expect(r.can({ kind: 'ANONYMOUS' }, action, {}, { now: new Date() }).allow).toBe(true);
  });
});

describe('B2: geo SQL touches only its own schema', () => {
  it('every statement', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(GEO_SQL)) expect(() => assertModuleOwnsSql('geo', sql, ownership), name).not.toThrow();
  });
});
