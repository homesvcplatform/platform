// Gate 6 exit criteria "pricing property tests (totals = Σ signed lines, rounding)" and "Model B and C configs for tests"
// (ADR-027 #4, D-07 configurable only): the pure quote engine. Fixture values only, NOT FINAL.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineAmount, toMilli } from '@hsp/money';
import {
  CREDIT_TYPES, FIXTURE_QUOTE_PRICING_POLICY as POLICY, priceQuote, signedTotal, type QuoteLineInput, type QuoteRateCard,
} from '../public/index.ts';

const ITEM_A = '00000000-0000-4000-8000-00000000000a';
const ITEM_B = '00000000-0000-4000-8000-00000000000b';
const MAT = '00000000-0000-4000-8000-0000000000c1';

function card(model: 'B' | 'C', over: Partial<QuoteRateCard> = {}): QuoteRateCard {
  return {
    rateCardId: `card-${model}`,
    repairItems: new Map([
      [ITEM_A, { rateCardItemId: 'ri-a', labourPaise: model === 'B' ? 30_000 : 35_000, minPaise: 15_000, maxPaise: 70_000, technicianShareBps: model === 'B' ? 7500 : 8000 }],
      [ITEM_B, { rateCardItemId: 'ri-b', labourPaise: 12_345, minPaise: 6000, maxPaise: 25_000, technicianShareBps: 7500 }],
    ]),
    platformFee: model === 'B' ? { amount_paise: 0 } : { amount_paise: 2900 },
    materialMarkupBps: 0,
    visitFeeCreditBps: model === 'B' ? 0 : 5000,
    customLabourBand: null,
    ruleRefs: {},
    ...over,
  };
}

const repair = (qty = 1, id = ITEM_A): QuoteLineInput => ({ type: 'REPAIR_ITEM', repairItemId: id, code: 'REP-X', qty });
const material = (qty: number, ref: number | null, proposed: number | null = null, reasonCode: string | null = null): QuoteLineInput =>
  ({ type: 'MATERIAL', materialId: MAT, code: 'MAT-X', qty, referenceUnitPaise: ref, proposedUnitPaise: proposed, reasonCode });

describe('quote engine: Model B and Model C fixtures', () => {
  it('Model B: fixed inspection fee, no credit, no platform fee', () => {
    const r = priceQuote(card('B'), { visitFeePaise: 19_900, lines: [repair(), material(2, 6000)] }, POLICY);
    if (!r.ok) throw new Error(r.code);
    expect(r.quote.lines.map((l) => [l.itemType, l.amountPaise])).toEqual([['VISIT_FEE', 19_900], ['LABOUR', 30_000], ['MATERIAL', 12_000]]);
    expect(r.quote.totals).toEqual({ itemsTotalPaise: 61_900, discountPaise: 0, visitFeeCreditPaise: 0, taxPaise: 0, totalPayablePaise: 61_900,
      technicianEarningsPaise: 22_500 + 12_000 });
  });

  it('Model C: partial visit-fee credit (G-8 VISIT_FEE_CREDIT line) and a flat platform fee', () => {
    const r = priceQuote(card('C'), { visitFeePaise: 14_900, lines: [repair(), material(2, 6000)] }, POLICY);
    if (!r.ok) throw new Error(r.code);
    expect(r.quote.lines.map((l) => [l.lineNo, l.itemType, l.amountPaise])).toEqual([
      [1, 'VISIT_FEE', 14_900], [2, 'LABOUR', 35_000], [3, 'MATERIAL', 12_000], [4, 'PLATFORM_FEE', 2900], [5, 'VISIT_FEE_CREDIT', 7450]]);
    expect(r.quote.totals.totalPayablePaise).toBe(14_900 + 35_000 + 12_000 + 2900 - 7450);
    expect(r.quote.totals.visitFeeCreditPaise).toBe(7450);
    expect(r.quote.totals.technicianEarningsPaise).toBe(28_000 + 12_000);
  });

  it('materials: the reference price, or a proposed price within ±20 % (else a reason); markup stays with the platform', () => {
    const near = priceQuote(card('B'), { visitFeePaise: 0, lines: [material(1, 10_000, 11_500)] }, POLICY);
    expect(near.ok && near.quote.lines[1]).toMatchObject({ unitPricePaise: 11_500, referenceUnitPricePaise: 10_000, deviationBps: 1500, deviationReasonCode: null });
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [material(1, 10_000, 13_000)] }, POLICY)).toMatchObject({ ok: false, code: 'MATERIAL_DEVIATION_NEEDS_REASON', line: 0 });
    const reasoned = priceQuote(card('B'), { visitFeePaise: 0, lines: [material(1, 10_000, 13_000, 'BRANDED_PART')] }, POLICY);
    expect(reasoned.ok && reasoned.quote.lines[1]).toMatchObject({ deviationBps: 3000, deviationReasonCode: 'BRANDED_PART' });
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [material(1, null)] }, POLICY)).toMatchObject({ ok: false, code: 'NO_REFERENCE_PRICE' });
    const marked = priceQuote(card('B', { materialMarkupBps: 1000 }), { visitFeePaise: 0, lines: [material(2, 10_000)] }, POLICY);
    expect(marked.ok && marked.quote.lines[1]).toMatchObject({ unitPricePaise: 11_000, amountPaise: 22_000, technicianSharePaise: 20_000 });
  });

  it('custom labour is refused outside the band, and always while no band is configured (D9: 422, fail closed)', () => {
    const custom: QuoteLineInput = { type: 'CUSTOM_LABOUR', qty: 1, proposedUnitPaise: 20_000, reasonCode: 'EXTRA_ACCESS_WORK' };
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [custom] }, POLICY)).toMatchObject({ ok: false, code: 'CUSTOM_LABOUR_OUT_OF_BAND' });
    const band = card('B', { customLabourBand: { minPaise: 10_000, maxPaise: 30_000, technicianShareBps: 8000 } });
    const inBand = priceQuote(band, { visitFeePaise: 0, lines: [custom] }, POLICY);
    expect(inBand.ok && inBand.quote.lines[1]).toMatchObject({ itemType: 'LABOUR', amountPaise: 20_000, technicianSharePaise: 16_000 });
    expect(priceQuote(band, { visitFeePaise: 0, lines: [{ ...custom, proposedUnitPaise: 30_001 }] }, POLICY)).toMatchObject({ ok: false, code: 'CUSTOM_LABOUR_OUT_OF_BAND' });
  });

  it('unknown items, empty quotes and bad quantities are refused', () => {
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [] }, POLICY)).toMatchObject({ ok: false, code: 'NO_LINES' });
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [repair(1, 'nope')] }, POLICY)).toMatchObject({ ok: false, code: 'UNKNOWN_REPAIR_ITEM' });
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [repair(0.0001)] }, POLICY)).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
    expect(priceQuote(card('B'), { visitFeePaise: 0, lines: [repair(0)] }, POLICY)).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
  });

  it('a percentage platform fee applies to the labour total', () => {
    const r = priceQuote(card('B', { platformFee: { bps: 1000 } }), { visitFeePaise: 0, lines: [repair(), repair(1, ITEM_B)] }, POLICY);
    expect(r.ok && r.quote.lines.find((l) => l.itemType === 'PLATFORM_FEE')?.amountPaise).toBe(Math.round((30_000 + 12_345) / 10));
  });
});

// ---------------------------------------------------------------- properties

const lineArb: fc.Arbitrary<QuoteLineInput> = fc.oneof(
  fc.record({ type: fc.constant('REPAIR_ITEM' as const), repairItemId: fc.constantFrom(ITEM_A, ITEM_B), code: fc.constant('REP-X'),
    qty: fc.integer({ min: 1, max: 5000 }).map((m) => m / 1000) }),
  fc.record({ type: fc.constant('MATERIAL' as const), materialId: fc.constant(MAT), code: fc.constant('MAT-X'),
    qty: fc.integer({ min: 1, max: 20_000 }).map((m) => m / 1000), referenceUnitPaise: fc.integer({ min: 1, max: 500_000 }),
    proposedUnitPaise: fc.constant(null), reasonCode: fc.constant(null) }),
);
const cardArb = fc.record({
  model: fc.constantFrom('B' as const, 'C' as const),
  credit: fc.integer({ min: 0, max: 10_000 }),
  platform: fc.oneof(fc.record({ amount_paise: fc.integer({ min: 0, max: 50_000 }) }), fc.record({ bps: fc.integer({ min: 0, max: 3000 }) })),
  markup: fc.integer({ min: 0, max: 5000 }),
});

describe('quote engine properties', () => {
  it('totals = Σ signed lines (credits subtracted), amounts ≥ 0, credit ≤ visit fee, line = round(qty × unit), deterministic', () => {
    fc.assert(fc.property(cardArb, fc.integer({ min: 0, max: 100_000 }), fc.array(lineArb, { minLength: 1, maxLength: 12 }), (c, visitFee, lines) => {
      const k = card(c.model, { visitFeeCreditBps: c.credit, platformFee: c.platform, materialMarkupBps: c.markup });
      const r = priceQuote(k, { visitFeePaise: visitFee, lines }, POLICY);
      if (!r.ok) throw new Error(r.code);
      const q = r.quote;
      expect(q.totals.totalPayablePaise).toBe(signedTotal(q.lines));
      expect(q.totals.totalPayablePaise).toBe(q.totals.itemsTotalPaise - q.totals.discountPaise - q.totals.visitFeeCreditPaise + q.totals.taxPaise);
      expect(q.totals.totalPayablePaise).toBeGreaterThanOrEqual(0);
      expect(q.totals.visitFeeCreditPaise).toBeLessThanOrEqual(visitFee);
      for (const l of q.lines) {
        expect(l.amountPaise).toBeGreaterThanOrEqual(0);
        expect(l.amountPaise).toBe(lineAmount(l.qtyMilli, l.unitPricePaise));
        expect(l.technicianSharePaise).toBeLessThanOrEqual(l.amountPaise);
        if (CREDIT_TYPES.has(l.itemType)) expect(l.technicianSharePaise).toBe(0);
      }
      expect(q.lines.map((l) => l.lineNo)).toEqual(q.lines.map((_, i) => i + 1));
      expect(q.totals.technicianEarningsPaise).toBeLessThanOrEqual(q.totals.itemsTotalPaise);
      expect(priceQuote(k, { visitFeePaise: visitFee, lines }, POLICY)).toEqual(r);
    }), { numRuns: 800 });
  });

  it('the labour split is exact: technician share + platform share = labour line', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 9999 }), (m) => {
      const r = priceQuote(card('B'), { visitFeePaise: 0, lines: [repair(m / 1000, ITEM_B)] }, POLICY);
      if (!r.ok) throw new Error(r.code);
      const labour = r.quote.lines.find((l) => l.itemType === 'LABOUR');
      expect(labour?.amountPaise).toBe(lineAmount(toMilli(m / 1000), 12_345));
      const share = labour?.technicianSharePaise ?? -1;
      expect(Math.abs(share - ((labour?.amountPaise ?? 0) * 7500) / 10_000)).toBeLessThanOrEqual(0.5);
    }), { numRuns: 500 });
  });
});
