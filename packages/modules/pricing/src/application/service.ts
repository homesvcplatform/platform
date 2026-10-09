// Pricing interface. Gate 5 (ADR-026 #1): the visit fee of a service type in a city at a time (ACTIVE rate card),
// immutable price snapshots, and the lifecycle fee rules. Gate 6 (ADR-027): the quote engine - `priceQuote` prices a
// diagnosis from the rate card (pure engine in domain/quote.ts) and, when asked, persists the snapshot (INV-21) - and
// the margin-warning check of a rate card (domain/margin.ts). Fixture rate cards only, NOT FINAL. Snapshots are
// written in pricing's own transaction, before the caller's (B4).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Clock } from '@hsp/kernel';
import { newId } from '@hsp/kernel';
import {
  cancellationParams, noShowParams, travelCompensationParams, waitingParams, type LifecycleFeeRules,
} from '../domain/fees.ts';
import { pricingModelFromCard, rateCardMarginWarnings, type SimulatorAssumptions } from '../domain/margin.ts';
import {
  materialMarkupParams, platformFeeParams, priceQuote, visitFeeCreditParams, type PricedQuote, type QuoteLineInput, type QuotePricingFailure,
  type QuotePricingPolicy, type QuoteRateCard, type RateCardRepairItem,
} from '../domain/quote.ts';
import { SQL } from '../infrastructure/sql.ts';

export const PRICING_ENGINE_VERSION = 'gate5-lifecycle-1';
export const QUOTE_ENGINE_VERSION = 'gate6-quote-1';

/** Quote pricing policy values: FIXTURE VALUES, NOT FINAL (the DB allows ±20 % without a reason). */
export const FIXTURE_QUOTE_PRICING_POLICY: QuotePricingPolicy = Object.freeze({ maxMaterialDeviationBps: 2000 });

export interface QuotePriceRequest {
  readonly cityId: string;
  readonly at: Date;
  /** Change orders are priced with the card of the version they extend, so approved lines keep their prices (INV-21). */
  readonly rateCardId?: string | undefined;
  readonly visitFeePaise: number;
  readonly lines: readonly QuoteLineInput[];
  /** Ids recorded in the snapshot inputs (job, diagnoses). */
  readonly refs: Readonly<Record<string, string | readonly string[]>>;
}

export type QuotePriceResult =
  | { readonly ok: true; readonly rateCardId: string; readonly quote: PricedQuote; readonly snapshotId: string | null }
  | { readonly ok: false; readonly code: QuotePricingFailure | 'NO_RATE_CARD'; readonly line: number | null };

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface PricingDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
}

export class PricingService {
  readonly #d: PricingDeps;

  constructor(deps: PricingDeps) {
    this.#d = deps;
  }

  async #card(cityId: string, at: Date): Promise<{ id: string; label: string } | null> {
    if (!UUID.test(cityId)) return null;
    const r = (await this.#d.pool.query(SQL.activeCard, [cityId, at])).rows[0] as Row | undefined;
    return r ? { id: r['id'] as string, label: r['label'] as string } : null;
  }

  /** The visit fee of a service type in a city at a time, or null when the city's active card has none. */
  async visitFee(serviceTypeId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<{ rateCardId: string; itemId: string; amountPaise: number } | null> {
    const card = await this.#card(cityId, at);
    if (!card || !UUID.test(serviceTypeId)) return null;
    const item = (await this.#d.pool.query(SQL.visitFeeItem, [card.id, serviceTypeId])).rows[0] as Row | undefined;
    return item ? { rateCardId: card.id, itemId: item['id'] as string, amountPaise: Number(item['labour_paise']) } : null;
  }

  /** The cancellation / no-show / waiting / travel rules of the city's active card; null if any is missing or invalid (fail closed). */
  async lifecycleFeeRules(cityId: string, at: Date = this.#d.clock.now()): Promise<LifecycleFeeRules | null> {
    const card = await this.#card(cityId, at);
    if (!card) return null;
    const rows = (await this.#d.pool.query(SQL.feeRules, [card.id])).rows as Row[];
    const params = (type: string) => rows.find((r) => r['fee_type'] === type)?.['params'];
    const c = cancellationParams.safeParse(params('CANCELLATION'));
    const n = noShowParams.safeParse(params('NO_SHOW'));
    const w = waitingParams.safeParse(params('WAITING'));
    const t = travelCompensationParams.safeParse(params('TRAVEL_COMPENSATION'));
    if (!c.success || !n.success || !w.success || !t.success) return null;
    return { rateCardId: card.id, cancellation: c.data, noShow: n.data, waiting: w.data, travelCompensation: t.data };
  }

  /** Writes an immutable snapshot (INV-21) of a pricing decision and returns its id. */
  async snapshot(input: { rateCardId: string; ruleRefs: Record<string, unknown>; inputs: Record<string, unknown>; outputs: Record<string, unknown>;
    engine?: string }): Promise<string> {
    const id = newId();
    const engine = input.engine ?? PRICING_ENGINE_VERSION;
    const hash = createHash('sha256').update(canonical({ rateCardId: input.rateCardId, ruleRefs: input.ruleRefs, inputs: input.inputs,
      outputs: input.outputs, engine })).digest();
    await this.#d.pool.query(SQL.insertSnapshot, [id, input.rateCardId, JSON.stringify(input.ruleRefs), JSON.stringify(input.inputs),
      JSON.stringify(input.outputs), engine, hash]);
    return id;
  }

  /** The quote-relevant part of a rate card (null when the card lacks a required fee rule: fail closed). */
  async #quoteCard(rateCardId: string, repairItemIds: readonly string[]): Promise<QuoteRateCard | null> {
    const rows = (await this.#d.pool.query(SQL.quoteFeeRules, [rateCardId])).rows as Row[];
    const rule = (type: string) => rows.find((r) => r['fee_type'] === type);
    const platform = platformFeeParams.safeParse(rule('PLATFORM_FEE')?.['params']);
    const credit = visitFeeCreditParams.safeParse(rule('VISIT_FEE_CREDIT')?.['params']);
    const markupRow = rule('MATERIAL_MARKUP');
    const markup = markupRow ? materialMarkupParams.safeParse(markupRow['params']) : { success: true as const, data: { bps: 0 } };
    if (!platform.success || !credit.success || !markup.success) return null;
    const items = new Map<string, RateCardRepairItem>();
    for (const r of (await this.#d.pool.query(SQL.repairItems, [rateCardId, repairItemIds.filter((i) => UUID.test(i))])).rows as Row[]) {
      items.set(r['repair_item_id'] as string, { rateCardItemId: r['id'] as string, labourPaise: Number(r['labour_paise']), minPaise: Number(r['min_paise']),
        maxPaise: Number(r['max_paise']), technicianShareBps: Number(r['technician_share_bps']) });
    }
    const ruleRefs: Record<string, string> = {};
    for (const r of rows) ruleRefs[r['fee_type'] as string] = r['id'] as string;
    return { rateCardId, repairItems: items, platformFee: platform.data, materialMarkupBps: markup.data.bps, visitFeeCreditBps: credit.data.credit_bps,
      customLabourBand: null, ruleRefs };
  }

  /**
   * Prices a quote (06 §7: the server prices; the client sends references and quantities). `persist` writes the
   * immutable snapshot (INV-21) and returns its id; a preview persists nothing. The card is the city's ACTIVE card at
   * `at`, or the given card for a change order (an existing card of the same city, whatever its status now).
   */
  async priceQuote(req: QuotePriceRequest, opts: { persist: boolean; policy?: QuotePricingPolicy } = { persist: false }): Promise<QuotePriceResult> {
    let cardId: string | null;
    if (req.rateCardId !== undefined) {
      const card = UUID.test(req.rateCardId) ? ((await this.#d.pool.query(SQL.card, [req.rateCardId])).rows[0] as Row | undefined) : undefined;
      cardId = card && card['city_id'] === req.cityId ? (card['id'] as string) : null;
    } else {
      cardId = (await this.#card(req.cityId, req.at))?.id ?? null;
    }
    if (!cardId) return { ok: false, code: 'NO_RATE_CARD', line: null };
    const repairIds = req.lines.flatMap((l) => (l.type === 'REPAIR_ITEM' ? [l.repairItemId] : []));
    const card = await this.#quoteCard(cardId, repairIds);
    if (!card) return { ok: false, code: 'NO_RATE_CARD', line: null };
    const policy = opts.policy ?? FIXTURE_QUOTE_PRICING_POLICY;
    const priced = priceQuote(card, { visitFeePaise: req.visitFeePaise, lines: req.lines }, policy);
    if (!priced.ok) return priced;
    if (!opts.persist) return { ok: true, rateCardId: cardId, quote: priced.quote, snapshotId: null };
    const ruleRefs = { ...card.ruleRefs, rateCardItemIds: repairIds.map((i) => card.repairItems.get(i)?.rateCardItemId ?? null) };
    const snapshotId = await this.snapshot({ rateCardId: cardId, ruleRefs, engine: QUOTE_ENGINE_VERSION,
      inputs: { cityId: req.cityId, at: req.at.toISOString(), visitFeePaise: req.visitFeePaise, lines: req.lines, policy, refs: req.refs },
      outputs: { lines: priced.quote.lines, totals: priced.quote.totals } });
    return { ok: true, rateCardId: cardId, quote: priced.quote, snapshotId };
  }

  /**
   * The margin-warning hook for a rate card (ADR-027 #12): the simulator scenarios of 1.1/06 for the card's values for a
   * service type. Meant to run before maker-checker activation; it warns and never blocks. Null if the card lacks the
   * values (no visit fee for the type, or a missing fee rule).
   */
  async marginCheck(rateCardId: string, serviceTypeId: string, assumptions?: SimulatorAssumptions) {
    if (!UUID.test(rateCardId) || !UUID.test(serviceTypeId)) return null;
    const fee = (await this.#d.pool.query(SQL.visitFeeItem, [rateCardId, serviceTypeId])).rows[0] as Row | undefined;
    const card = await this.#quoteCard(rateCardId, []);
    const rows = (await this.#d.pool.query(SQL.quoteFeeRules, [rateCardId])).rows as Row[];
    const payout = rows.find((r) => r['fee_type'] === 'DIAGNOSIS_PAYOUT')?.['params'] as { amount_paise?: unknown } | undefined;
    if (!fee || !card || typeof payout?.amount_paise !== 'number') return null;
    // A percentage platform fee is evaluated on the simulator's labour assumption.
    const labourPaise = Math.round((assumptions?.labour ?? 400) * 100);
    const platformFeePaise = 'amount_paise' in card.platformFee ? card.platformFee.amount_paise : Math.round((labourPaise * card.platformFee.bps) / 10_000);
    const model = pricingModelFromCard({ visitFeePaise: Number(fee['labour_paise']), visitFeeCreditBps: card.visitFeeCreditBps, platformFeePaise,
      diagnosisPayoutPaise: payout.amount_paise });
    return { model, ...rateCardMarginWarnings(model, assumptions) };
  }

  /** The visit fee plus its snapshot, as booking stores it (04 §7: the client can't set prices). */
  async snapshotVisitFee(serviceTypeId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<{ snapshotId: string; amountPaise: number } | null> {
    const fee = await this.visitFee(serviceTypeId, cityId, at);
    if (!fee) return null;
    const snapshotId = await this.snapshot({ rateCardId: fee.rateCardId, ruleRefs: { visitFeeItemId: fee.itemId },
      inputs: { serviceTypeId, cityId, at: at.toISOString() }, outputs: { visitFeePaise: fee.amountPaise } });
    return { snapshotId, amountPaise: fee.amountPaise };
  }

  /** The rate card a snapshot was priced with (change orders are priced with the same card). */
  async snapshotRateCardId(snapshotId: string): Promise<string | null> {
    if (!UUID.test(snapshotId)) return null;
    const r = (await this.#d.pool.query(SQL.snapshot, [snapshotId])).rows[0] as Row | undefined;
    return (r?.['rate_card_id'] as string | undefined) ?? null;
  }

  /** The amount stored in a visit-fee snapshot (for the TCP-3 placeholder and reads). */
  async snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null> {
    if (!UUID.test(snapshotId)) return null;
    const r = (await this.#d.pool.query(SQL.snapshot, [snapshotId])).rows[0] as Row | undefined;
    return (r?.['outputs'] as Record<string, unknown> | undefined) ?? null;
  }
}
