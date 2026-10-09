// Gate 6 exit criterion "pricing property tests (rounding)": integer paise maths (Phase 1 09 §9). Line amounts round
// half-up exactly like PostgreSQL's round(numeric) on non-negative values (the quote-item CHECK), and every split is
// exact (largest remainder: the parts sum to the whole).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyBps, divRoundHalfUp, formatInr, largestRemainder, lineAmount, milliToString, MoneyError, splitBps, toMilli } from '../index.ts';

const RUNS = { numRuns: 1000 };

/** Reference: exact decimal round-half-up of qty(3 dp) × unit using BigInt arithmetic on the decimal string. */
function referenceLineAmount(qtyMilli: number, unit: number): number {
  const product = BigInt(qtyMilli) * BigInt(unit); // value × 1000
  const whole = product / 1000n;
  const frac = product % 1000n;
  return Number(frac >= 500n ? whole + 1n : whole);
}

describe('rounding', () => {
  it('line amount = round(qty × unit), half-up, as numeric(10,3) × bigint in PostgreSQL', () => {
    expect(lineAmount(2500, 6000)).toBe(15_000);
    expect(lineAmount(1500, 3)).toBe(5); // 4.5 → 5
    expect(lineAmount(1499, 3)).toBe(4); // 4.497 → 4
    expect(lineAmount(333, 1)).toBe(0); // 0.333 → 0
    expect(lineAmount(500, 1)).toBe(1); // 0.5 → 1
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), (q, u) => {
      expect(lineAmount(q, u)).toBe(referenceLineAmount(q, u));
    }), RUNS);
  });

  it('bps and division round half-up and stay exact for large values', () => {
    expect(applyBps(14_900, 5000)).toBe(7450);
    expect(applyBps(19_900, 0)).toBe(0);
    expect(applyBps(3, 5000)).toBe(2); // 1.5 → 2
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(Number.MAX_SAFE_INTEGER - 1, 2)).toBe(Math.round((Number.MAX_SAFE_INTEGER - 1) / 2));
    fc.assert(fc.property(fc.integer({ min: 0, max: 100_000_000 }), fc.integer({ min: 0, max: 10_000 }), (a, b) => {
      const product = BigInt(a) * BigInt(b);
      const exact = Number(product / 10_000n + (product % 10_000n >= 5000n ? 1n : 0n));
      expect(applyBps(a, b)).toBe(exact);
    }), RUNS);
  });

  it('quantities: thousandths in, numeric text out; more than 3 decimals, negatives and non-finite values are refused', () => {
    expect(toMilli(2.5)).toBe(2500);
    expect(toMilli(0.001)).toBe(1);
    expect(milliToString(2500)).toBe('2.500');
    expect(milliToString(1)).toBe('0.001');
    for (const bad of [-1, 0.0001, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => toMilli(bad)).toThrow(MoneyError);
    fc.assert(fc.property(fc.integer({ min: 0, max: 9_999_999_999 }), (m) => {
      expect(toMilli(Number(milliToString(m)))).toBe(m);
    }), RUNS);
  });
});

describe('splits (largest remainder)', () => {
  it('parts always sum exactly to the whole, each within 1 paisa of its exact share', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 50_000_000 }), fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 6 })
      .filter((w) => w.some((x) => x > 0)), (total, weights) => {
      const parts = largestRemainder(total, weights);
      const sum = weights.reduce((a, b) => a + b, 0);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p, i) => expect(Math.abs(p - (total * (weights[i] ?? 0)) / sum)).toBeLessThan(1));
    }), RUNS);
  });

  it('technician share + platform share = the labour line (two-way bps split)', () => {
    expect(splitBps(30_000, 7500)).toEqual([22_500, 7500]);
    expect(splitBps(1, 5000)).toEqual([1, 0]); // tie → the earlier part
    expect(splitBps(10, 0)).toEqual([0, 10]);
    fc.assert(fc.property(fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 0, max: 10_000 }), (amount, bps) => {
      const [share, rest] = splitBps(amount, bps);
      expect(share + rest).toBe(amount);
      expect(share).toBeGreaterThanOrEqual(0);
      expect(rest).toBeGreaterThanOrEqual(0);
    }), RUNS);
    expect(() => splitBps(100, 10_001)).toThrow(MoneyError);
    expect(() => largestRemainder(100, [0, 0])).toThrow(MoneyError);
  });

  it('formats INR with Indian grouping (display only)', () => {
    expect(formatInr(123_456_789)).toBe('₹12,34,567.89');
    expect(formatInr(14_900)).toBe('₹149.00');
    expect(formatInr(-5)).toBe('-₹0.05');
  });
});
