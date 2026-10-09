// Minimal read-only pricing interface for Gate 5 (ADR-026 #1): the visit fee of a service type in a city at a time
// (ACTIVE rate card), immutable price snapshots, and the lifecycle fee rules. Fixture rate cards only, NOT FINAL. No
// quote engine, quote versions or repair pricing (Gate 6). Snapshots are written in pricing's own transaction (B4).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Clock } from '@hsp/kernel';
import { newId } from '@hsp/kernel';
import {
  cancellationParams, noShowParams, travelCompensationParams, waitingParams, type LifecycleFeeRules,
} from '../domain/fees.ts';
import { SQL } from '../infrastructure/sql.ts';

export const PRICING_ENGINE_VERSION = 'gate5-lifecycle-1';

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
  async snapshot(input: { rateCardId: string; ruleRefs: Record<string, unknown>; inputs: Record<string, unknown>; outputs: Record<string, unknown> }): Promise<string> {
    const id = newId();
    const hash = createHash('sha256').update(canonical({ rateCardId: input.rateCardId, ruleRefs: input.ruleRefs, inputs: input.inputs,
      outputs: input.outputs, engine: PRICING_ENGINE_VERSION })).digest();
    await this.#d.pool.query(SQL.insertSnapshot, [id, input.rateCardId, JSON.stringify(input.ruleRefs), JSON.stringify(input.inputs),
      JSON.stringify(input.outputs), PRICING_ENGINE_VERSION, hash]);
    return id;
  }

  /** The visit fee plus its snapshot, as booking stores it (04 §7: the client can't set prices). */
  async snapshotVisitFee(serviceTypeId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<{ snapshotId: string; amountPaise: number } | null> {
    const fee = await this.visitFee(serviceTypeId, cityId, at);
    if (!fee) return null;
    const snapshotId = await this.snapshot({ rateCardId: fee.rateCardId, ruleRefs: { visitFeeItemId: fee.itemId },
      inputs: { serviceTypeId, cityId, at: at.toISOString() }, outputs: { visitFeePaise: fee.amountPaise } });
    return { snapshotId, amountPaise: fee.amountPaise };
  }

  /** The amount stored in a visit-fee snapshot (for the TCP-3 placeholder and reads). */
  async snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null> {
    if (!UUID.test(snapshotId)) return null;
    const r = (await this.#d.pool.query(SQL.snapshot, [snapshotId])).rows[0] as Row | undefined;
    return (r?.['outputs'] as Record<string, unknown> | undefined) ?? null;
  }
}
