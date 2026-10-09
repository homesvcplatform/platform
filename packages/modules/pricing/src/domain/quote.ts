// Quote pricing (Phase 1 06 §7 "only the server prices", 09 §9, errata G-8, D-07 "configurable only"). A pure,
// deterministic function of the rate card and the diagnosis lines: no I/O, no clock. The client sends item references
// and quantities only; unit prices come from the rate card (labour), the city's material reference price (materials,
// optionally a technician-proposed price within the deviation policy or with a reason), and fee rules (platform fee,
// material markup, visit-fee credit). Values are fixture rate cards, NOT FINAL.
import { z } from 'zod';
import { applyBps, lineAmount, splitBps, toMilli } from '@hsp/money';

const paise = z.int().min(0).max(10_000_000);
const bps = z.int().min(0).max(10_000);
const fixture = z.literal('NOT_FINAL').optional();

/** PLATFORM_FEE: a flat amount per repaired job (Model C: ₹29) or a share of the labour total. */
export const platformFeeParams = z.union([
  z.strictObject({ amount_paise: paise, fixture }),
  z.strictObject({ bps, fixture }),
]);
export const materialMarkupParams = z.strictObject({ bps, fixture });
/** VISIT_FEE_CREDIT (ADR-027 #4): share of the visit fee credited on the quote (Model B 0 %, Model C 50 %). */
export const visitFeeCreditParams = z.strictObject({ credit_bps: bps, fixture });

export type PlatformFeeParams = z.infer<typeof platformFeeParams>;

export interface RateCardRepairItem {
  readonly rateCardItemId: string;
  readonly labourPaise: number;
  readonly minPaise: number;
  readonly maxPaise: number;
  readonly technicianShareBps: number;
}

export interface QuoteRateCard {
  readonly rateCardId: string;
  readonly repairItems: ReadonlyMap<string, RateCardRepairItem>;
  readonly platformFee: PlatformFeeParams;
  readonly materialMarkupBps: number;
  readonly visitFeeCreditBps: number;
  /** Band for custom labour lines; null = none configured, so every custom labour line is refused (D9, fail closed). */
  readonly customLabourBand: { readonly minPaise: number; readonly maxPaise: number; readonly technicianShareBps: number } | null;
  /** Fee rule ids used (snapshot rule references). */
  readonly ruleRefs: Readonly<Record<string, string>>;
}

export type QuoteLineInput =
  | { readonly type: 'REPAIR_ITEM'; readonly repairItemId: string; readonly code: string; readonly qty: number }
  | { readonly type: 'MATERIAL'; readonly materialId: string; readonly code: string; readonly qty: number;
      readonly referenceUnitPaise: number | null; readonly proposedUnitPaise: number | null; readonly reasonCode: string | null }
  | { readonly type: 'CUSTOM_LABOUR'; readonly qty: number; readonly proposedUnitPaise: number; readonly reasonCode: string };

export interface QuotePricingPolicy {
  /** A proposed material price further than this from the reference needs a reason code (DB: ±20 % without a reason). */
  readonly maxMaterialDeviationBps: number;
}

export type QuoteItemType = 'VISIT_FEE' | 'VISIT_FEE_CREDIT' | 'LABOUR' | 'MATERIAL' | 'PLATFORM_FEE' | 'DISCOUNT' | 'TAX';

export interface PricedLine {
  readonly lineNo: number;
  readonly itemType: QuoteItemType;
  readonly repairItemId: string | null;
  readonly materialId: string | null;
  readonly labelKey: string;
  readonly labelParams: Readonly<Record<string, string>>;
  readonly qtyMilli: number;
  readonly unitPricePaise: number;
  readonly amountPaise: number;
  readonly referenceUnitPricePaise: number | null;
  readonly deviationBps: number | null;
  readonly deviationReasonCode: string | null;
  readonly taxRateBps: number;
  readonly technicianSharePaise: number;
}

export interface QuoteTotals {
  readonly itemsTotalPaise: number;
  readonly discountPaise: number;
  readonly visitFeeCreditPaise: number;
  readonly taxPaise: number;
  readonly totalPayablePaise: number;
  readonly technicianEarningsPaise: number;
}

export interface PricedQuote {
  readonly lines: readonly PricedLine[];
  readonly totals: QuoteTotals;
}

export type QuotePricingFailure =
  | 'NO_LINES' | 'UNKNOWN_REPAIR_ITEM' | 'NO_REFERENCE_PRICE' | 'MATERIAL_DEVIATION_NEEDS_REASON' | 'CUSTOM_LABOUR_OUT_OF_BAND' | 'INVALID_QUANTITY';

export type QuotePricingResult = { readonly ok: true; readonly quote: PricedQuote } | { readonly ok: false; readonly code: QuotePricingFailure; readonly line: number | null };

/** Credit types are subtracted (G-8); amounts are always ≥ 0. */
export const CREDIT_TYPES: ReadonlySet<QuoteItemType> = new Set(['VISIT_FEE_CREDIT', 'DISCOUNT']);

/** Signed sum: totals = Σ lines with credit types negative (G-8). */
export function signedTotal(lines: readonly Pick<PricedLine, 'itemType' | 'amountPaise'>[]): number {
  return lines.reduce((s, l) => s + (CREDIT_TYPES.has(l.itemType) ? -l.amountPaise : l.amountPaise), 0);
}

function deviationBps(proposed: number, reference: number): number {
  const d = (BigInt(proposed) - BigInt(reference)) * 10_000n / BigInt(reference);
  return Number(d);
}

/**
 * Prices a quote: VISIT_FEE first, then labour (repair items, custom labour) and material lines in input order, then the
 * platform fee (only when there is labour) and the visit-fee credit. Technician shares: labour split by the rate-card
 * share (largest remainder), materials reimbursed at cost (the markup stays with the platform), fees 0.
 */
export function priceQuote(card: QuoteRateCard, input: { readonly visitFeePaise: number; readonly lines: readonly QuoteLineInput[] },
  policy: QuotePricingPolicy): QuotePricingResult {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES', line: null };
  const out: Omit<PricedLine, 'lineNo'>[] = [];
  const base = { repairItemId: null, materialId: null, referenceUnitPricePaise: null, deviationBps: null, deviationReasonCode: null, taxRateBps: 0 };
  out.push({ ...base, itemType: 'VISIT_FEE', labelKey: 'quote.line.visit_fee', labelParams: {}, qtyMilli: 1000, unitPricePaise: input.visitFeePaise,
    amountPaise: input.visitFeePaise, technicianSharePaise: 0 });
  let labourTotal = 0;
  for (const [index, l] of input.lines.entries()) {
    let qtyMilli: number;
    try {
      qtyMilli = toMilli(l.qty);
    } catch {
      return { ok: false, code: 'INVALID_QUANTITY', line: index };
    }
    if (qtyMilli === 0) return { ok: false, code: 'INVALID_QUANTITY', line: index };
    if (l.type === 'REPAIR_ITEM') {
      const item = card.repairItems.get(l.repairItemId);
      if (!item) return { ok: false, code: 'UNKNOWN_REPAIR_ITEM', line: index };
      const amount = lineAmount(qtyMilli, item.labourPaise);
      labourTotal += amount;
      out.push({ ...base, itemType: 'LABOUR', repairItemId: l.repairItemId, labelKey: 'quote.line.repair_item', labelParams: { code: l.code }, qtyMilli,
        unitPricePaise: item.labourPaise, amountPaise: amount, technicianSharePaise: splitBps(amount, item.technicianShareBps)[0] });
    } else if (l.type === 'CUSTOM_LABOUR') {
      const band = card.customLabourBand;
      if (!band || l.proposedUnitPaise < band.minPaise || l.proposedUnitPaise > band.maxPaise) return { ok: false, code: 'CUSTOM_LABOUR_OUT_OF_BAND', line: index };
      const amount = lineAmount(qtyMilli, l.proposedUnitPaise);
      labourTotal += amount;
      out.push({ ...base, itemType: 'LABOUR', labelKey: 'quote.line.custom_labour', labelParams: { reasonCode: l.reasonCode }, qtyMilli,
        unitPricePaise: l.proposedUnitPaise, amountPaise: amount, technicianSharePaise: splitBps(amount, band.technicianShareBps)[0] });
    } else {
      if (l.referenceUnitPaise === null) return { ok: false, code: 'NO_REFERENCE_PRICE', line: index };
      const costUnit = l.proposedUnitPaise ?? l.referenceUnitPaise;
      const deviation = l.proposedUnitPaise === null ? null : deviationBps(l.proposedUnitPaise, l.referenceUnitPaise);
      if (deviation !== null && Math.abs(deviation) > policy.maxMaterialDeviationBps && !l.reasonCode) {
        return { ok: false, code: 'MATERIAL_DEVIATION_NEEDS_REASON', line: index };
      }
      const unit = costUnit + applyBps(costUnit, card.materialMarkupBps);
      const amount = lineAmount(qtyMilli, unit);
      out.push({ ...base, itemType: 'MATERIAL', materialId: l.materialId, labelKey: 'quote.line.material', labelParams: { code: l.code }, qtyMilli,
        unitPricePaise: unit, amountPaise: amount, referenceUnitPricePaise: l.referenceUnitPaise, deviationBps: deviation,
        deviationReasonCode: deviation !== null && Math.abs(deviation) > policy.maxMaterialDeviationBps ? l.reasonCode : null,
        technicianSharePaise: Math.min(amount, lineAmount(qtyMilli, costUnit)) });
    }
  }
  if (labourTotal > 0) {
    const fee = 'amount_paise' in card.platformFee ? card.platformFee.amount_paise : applyBps(labourTotal, card.platformFee.bps);
    if (fee > 0) out.push({ ...base, itemType: 'PLATFORM_FEE', labelKey: 'quote.line.platform_fee', labelParams: {}, qtyMilli: 1000, unitPricePaise: fee, amountPaise: fee, technicianSharePaise: 0 });
  }
  const credit = Math.min(input.visitFeePaise, applyBps(input.visitFeePaise, card.visitFeeCreditBps));
  if (credit > 0) {
    out.push({ ...base, itemType: 'VISIT_FEE_CREDIT', labelKey: 'quote.line.visit_fee_credit', labelParams: {}, qtyMilli: 1000, unitPricePaise: credit, amountPaise: credit, technicianSharePaise: 0 });
  }
  const lines = out.map((l, i) => ({ ...l, lineNo: i + 1 }));
  const sum = (types: QuoteItemType[]) => lines.filter((l) => types.includes(l.itemType)).reduce((s, l) => s + l.amountPaise, 0);
  const totals: QuoteTotals = {
    itemsTotalPaise: sum(['VISIT_FEE', 'LABOUR', 'MATERIAL', 'PLATFORM_FEE']),
    discountPaise: sum(['DISCOUNT']),
    visitFeeCreditPaise: sum(['VISIT_FEE_CREDIT']),
    taxPaise: sum(['TAX']),
    totalPayablePaise: signedTotal(lines),
    technicianEarningsPaise: lines.reduce((s, l) => s + l.technicianSharePaise, 0),
  };
  return { ok: true, quote: { lines, totals } };
}
