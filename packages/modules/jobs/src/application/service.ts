// jobs application service (Phase 1 06 §2–§4, §8, §10, §13; 04 §7, §10, §12; Gate 5 ADR-026, Gate 6 ADR-027). Every command
// runs in one transaction that: locks the aggregate, checks the transition table, sets the actor context (history,
// INV-18), schedules / cancels its timers, writes outbox events and an audit row (last). Writes that belong to other
// modules (price snapshots) and reads of other modules (quote facts) happen before the transaction (B4); only the
// approved coupling points join it: TCP-2 (material usage at repair completion) and TCP-3 (the bill).
import type pg from 'pg';
import {
  appendAudit, beginIdempotent, cancelTimer, completeIdempotent, IdempotencyConflict, scheduleTimer, UnitOfWork, withTransaction,
  type AuditEntry,
} from '@hsp/db';
import { AppError } from '@hsp/errors';
import { consumeOnce, type EventConsumer, type OutboxEvent } from '@hsp/events';
import { newId, type Clock } from '@hsp/kernel';
import { lineAmount, milliToString, toMilli } from '@hsp/money';
import { cancellationFee, noShowFee, waitingFee, type LifecycleFeeRules } from '@hsp/module-pricing';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry } from '@hsp/policy';
import { constantTimeEqual, hmacSha256, numericCode, sha256 } from '@hsp/security';
import type { LifecyclePolicy } from '../domain/policy.ts';
import { bookingWindow, cancellationStage, disclosure, matchStartAt, newPublicRef, type DisclosureLevel } from '../domain/rules.ts';
import { assertTransition, isTerminal, type VisitStatus } from '../domain/transitions.ts';
import { SQL } from '../infrastructure/sql.ts';
import type {
  AddressBook, ApprovedQuoteFacts, BillIssuer, BillKind, LifecyclePricing, LocalityDistance, MaterialUsageRecorder, QuotedMaterial, RepairQuotes,
  RepairSkills, ServiceOffer, TechnicianCapacity,
} from '../public/ports.ts';

export interface JobsDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policies: PolicyRegistry;
  readonly policy: LifecyclePolicy;
  /** HMAC key for start / completion codes (never stored in clear). */
  readonly codeKey: Buffer;
  /** HMAC key for the audit IP hash. */
  readonly requestHashKey: Buffer;
  readonly addresses: AddressBook;
  readonly offers: ServiceOffer;
  readonly pricing: LifecyclePricing;
  readonly technicians: TechnicianCapacity;
  readonly localities: LocalityDistance;
  readonly bills: BillIssuer;
  /** Gate 6: diagnosis facts (read before transactions), TCP-2 material usage, workforce repair skills. */
  readonly repairQuotes: RepairQuotes;
  readonly materialUsage: MaterialUsageRecorder;
  readonly repairSkills: RepairSkills;
  /** compliance disclosure log (INV-17): called before any L2 field is returned. */
  readonly recordDisclosure: (e: { visitId: string; viewerType: 'TECHNICIAN'; viewerId: string; dataKind: 'EXACT_ADDRESS'; channel: 'APP' }) => Promise<void>;
}

export interface RequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
}

export type Timing = { readonly type: 'ASAP' } | { readonly type: 'SLOT'; readonly start: string; readonly end: string };

export interface BookingInput {
  readonly clientRequestId: string;
  readonly serviceTypeId: string;
  readonly symptomCodes: readonly string[];
  readonly addressId: string;
  readonly timing: Timing;
  readonly acceptedVisitFeePaise: number;
  readonly confirmSeparate: boolean;
  readonly paymentPreference: 'ONLINE' | 'CASH' | 'EITHER';
  readonly onsiteAdult: 'SELF' | 'ADULT_FAMILY' | 'OTHER_ADULT';
}

/** Repair completion input (04 §10): outcome, and for a complete repair the usage of every quoted material. */
export interface CompletionInput {
  readonly outcome: 'COMPLETE' | 'PARTIAL';
  readonly partialReasonCode?: string | undefined;
  readonly materialUsage: readonly { readonly quoteItemId: string; readonly qtyUsed: number; readonly actualUnitCostPaise?: number | undefined }[];
}

/** Facade read for the diagnosis module: the visit a diagnosis is captured on. */
export interface DiagnosisVisitFacts {
  readonly visitId: string;
  readonly jobId: string;
  readonly cityId: string;
  readonly status: string;
  readonly purposes: readonly string[];
  readonly repairOrderId: string | null;
  readonly serviceTypeId: string;
  readonly customerUserId: string;
  readonly jobStatus: string;
  readonly visitFeeSnapshotId: string;
  readonly customerVerified: boolean;
  readonly activeTechnicianUserId: string | null;
}

/** Facade read for the diagnosis module: the job a quote belongs to. */
export interface QuoteJobFacts {
  readonly jobId: string;
  readonly customerUserId: string;
  readonly cityId: string;
  readonly status: string;
  readonly serviceTypeId: string;
  readonly visitFeeSnapshotId: string;
  readonly customerVerified: boolean;
  readonly openRepairOrderId: string | null;
  readonly openRepairOrderStatus: string | null;
}

interface PreparedCompletion {
  readonly ro: Record<string, unknown>;
  readonly facts: ApprovedQuoteFacts;
  readonly lines: readonly { readonly quoteItemId: string; readonly qtyUsed: number; readonly actualUnitCostPaise: number | null }[];
  readonly snapshotId: string | null;
  readonly amountDue: number;
}

interface CompletionBody {
  readonly visitStatus: 'COMPLETED';
  readonly repairOrderStatus: 'COMPLETED' | 'BLOCKED';
  readonly billId: string | null;
  readonly amountDuePaise: number | null;
}

/** The fields jobs reads from a quote event payload (IDs / enums / times only, 01 §5.1). */
function quoteEventPayload(e: OutboxEvent): { jobId: string; quoteVersionId: string; visitId: string; changeOrder: boolean; presentedAt: Date } {
  const p = e.payload;
  const str = (k: string) => {
    const v = p[k];
    if (typeof v !== 'string') throw new AppError('INVALID_STATE');
    return v;
  };
  return { jobId: str('jobId'), quoteVersionId: str('quoteVersionId'), visitId: str('visitId'), changeOrder: p['changeOrder'] === true,
    presentedAt: typeof p['presentedAt'] === 'string' ? new Date(p['presentedAt']) : e.occurredAt };
}

export const TIMER_TASKS = {
  matchStart: 'jobs.visit.match_start',
  matchSla: 'jobs.visit.match_sla',
  techNoShow: 'jobs.visit.tech_no_show',
  customerNoShow: 'jobs.visit.customer_no_show',
  overrun: 'jobs.visit.overrun',
  autoCheckout: 'jobs.visit.auto_checkout',
  repairUnscheduled: 'jobs.repair_order.unscheduled',
  blockedFollowup: 'jobs.repair_order.blocked_followup',
  sweep: 'jobs.sweep',
} as const;

/** TCP-2 / TCP-3 (tools/architecture/modules.json): the only cross-module calls allowed inside a jobs transaction. */
const TCPS = [
  { id: 'TCP-2', caller: 'jobs', callee: 'diagnosis', operation: 'recordMaterialUsage' },
  { id: 'TCP-3', caller: 'jobs', callee: 'payments', operation: 'issueBill' },
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TECH_IDEMPOTENCY_TTL_MS = 7 * 24 * 3_600_000; // X-20: offline replays

type Row = Record<string, unknown>;
type HistoryActor = { readonly type: 'CUSTOMER' | 'TECHNICIAN' | 'ADMIN' | 'SYSTEM'; readonly id: string | null; readonly channel: string };
const SYSTEM: HistoryActor = { type: 'SYSTEM', id: null, channel: 'SYSTEM' };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const timerKey = (visitId: string, task: keyof typeof TIMER_TASKS) => `visit:${visitId}:${task}`;
const VISIT_TIMERS = ['matchStart', 'matchSla', 'techNoShow', 'customerNoShow', 'overrun', 'autoCheckout'] as const;

export class JobsService {
  readonly #d: JobsDeps;

  constructor(deps: JobsDeps) {
    this.#d = deps;
  }

  #now(): Date {
    return this.#d.clock.now();
  }

  #require(actor: Actor, action: string, resource: unknown): void {
    const d = this.#d.policies.can(actor, action, resource, { now: this.#now() });
    if (!d.allow) throw new AppError(d.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN');
  }

  #codeHash(visitId: string, kind: 'start' | 'completion', code: string): Buffer {
    return hmacSha256(this.#d.codeKey, `${visitId}|${kind}|${code}`);
  }

  async #context(c: pg.ClientBase, who: HistoryActor, meta: RequestMeta | null, reason: string | null = null): Promise<void> {
    const corr = meta && UUID.test(meta.requestId) ? meta.requestId : newId();
    await c.query(SQL.actorContext, [who.type, who.id ?? '', who.channel, corr, reason ?? '']);
  }

  async #audit(c: pg.ClientBase, entry: AuditEntry, meta: RequestMeta | null): Promise<void> {
    await appendAudit(c, { ...entry, requestId: meta?.requestId ?? null, ipHash: meta ? hmacSha256(this.#d.requestHashKey, `ip|${meta.clientIp}`) : null });
  }

  async #event(c: pg.ClientBase, type: string, aggregate: 'Job' | 'Visit' | 'RepairOrder', id: string, version: number, cityId: string | null,
    payload: Record<string, string | number | boolean | null>, meta: RequestMeta | null): Promise<void> {
    await c.query(SQL.outbox, [newId(), type, aggregate, id, version, JSON.stringify(payload),
      meta && UUID.test(meta.requestId) ? meta.requestId : newId(), cityId, this.#now()]);
  }

  async #schedule(c: pg.ClientBase, visitId: string, task: (typeof VISIT_TIMERS)[number], at: Date): Promise<void> {
    await scheduleTimer(c, { task: TIMER_TASKS[task], key: timerKey(visitId, task), runAt: at, payload: { visitId } });
  }

  async #cancelTimers(c: pg.ClientBase, visitId: string, tasks: readonly (typeof VISIT_TIMERS)[number][] = VISIT_TIMERS): Promise<void> {
    for (const t of tasks) await cancelTimer(c, timerKey(visitId, t));
  }

  /** Runs `fn` under an Idempotency-Key; a replay returns the stored response (an error response is re-thrown). */
  async #idempotent<T>(c: pg.ClientBase, req: { actorKey: string; key: string; endpoint: string; body: unknown; ttlMs?: number },
    fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
    const idem = { actorKey: req.actorKey, idemKey: req.key, endpoint: req.endpoint, requestHash: sha256(canonical(req.body)), now: this.#now(),
      ...(req.ttlMs ? { ttlMs: req.ttlMs } : {}) };
    let start;
    try {
      start = await beginIdempotent(c, idem);
    } catch (error) {
      if (error instanceof IdempotencyConflict) {
        throw error.reason === 'KEY_REUSED' ? new AppError('IDEMPOTENCY_KEY_REUSED') : new AppError('REQUEST_IN_PROGRESS', { retryAfterSec: 1 });
      }
      throw error;
    }
    if (start.kind === 'REPLAY') {
      if (start.status >= 400) {
        const b = start.body as { code?: string; details?: Record<string, string | number | boolean> };
        throw new AppError((b.code ?? 'INTERNAL') as never, b.details ? { details: b.details } : {});
      }
      return { status: start.status, body: start.body as T, replayed: true };
    }
    const r = await fn();
    await completeIdempotent(c, idem, r.status, r.body);
    return { ...r, replayed: false };
  }

  /** The context handed to a TCP callee: the caller's connection (its own schema only, B2) inside this transaction. */
  async #transactionContext(c: pg.ClientBase) {
    return { transactionId: String((await c.query('SELECT txid_current() AS t')).rows[0]?.t ?? ''), db: c };
  }

  // ---------------------------------------------------------------- booking (04 §7, 06 §13)

  /** Customer booking from a verified session (customer_verified = true). */
  async bookJob(actor: Actor, input: BookingInput, idempotencyKey: string, meta: RequestMeta) {
    this.#require(actor, 'jobs.job.create', {});
    return this.#book({ customerUserId: actor.id ?? '', by: { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, verified: true,
      jobChannel: 'PWA', endpoint: 'POST /v1/customer/jobs' }, actor, input, idempotencyKey, meta);
  }

  /** Ops-assisted booking (06 §13): customer_verified = false until the customer verifies or ops confirms by call (G-4). */
  async bookAssisted(actor: Actor, input: BookingInput & { readonly customerUserId: string }, idempotencyKey: string, meta: RequestMeta) {
    this.#require(actor, 'jobs.job.create_assisted', { cityId: undefined });
    return this.#book({ customerUserId: input.customerUserId, by: { type: 'ADMIN', id: actor.id ?? null, channel: 'OPS' }, verified: false,
      jobChannel: 'OPS_DESK', endpoint: 'POST /admin/v1/jobs' }, actor, input, idempotencyKey, meta);
  }

  async #book(k: { customerUserId: string; by: HistoryActor; verified: boolean; jobChannel: 'PWA' | 'OPS_DESK'; endpoint: string },
    actor: Actor, input: BookingInput, idempotencyKey: string, meta: RequestMeta) {
    const now = this.#now();
    const address = await this.#d.addresses.addressForBooking(k.customerUserId, input.addressId);
    if (!address) throw new AppError('NOT_FOUND');
    if (k.by.type === 'ADMIN') this.#require(actor, 'jobs.job.create_assisted', { cityId: address.cityId });
    if (!address.serviceable) throw new AppError('NOT_SERVICEABLE');
    if (!(await this.#d.offers.isOffered(input.serviceTypeId, address.cityId, now))) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'serviceTypeId', code: 'NOT_OFFERED' }] });
    }
    const known = new Set(await this.#d.offers.symptomCodes(input.serviceTypeId));
    if (input.symptomCodes.some((s) => !known.has(s))) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'symptomCodes', code: 'UNKNOWN' }] });
    const window = bookingWindow(input.timing.type === 'ASAP' ? { type: 'ASAP' }
      : { type: 'SLOT', start: new Date(input.timing.start), end: new Date(input.timing.end) }, now, this.#d.policy);
    if (!window) throw new AppError('SLOT_UNAVAILABLE');
    const fee = await this.#d.pricing.visitFee(input.serviceTypeId, address.cityId, now);
    if (!fee) throw new AppError('INVALID_STATE');
    if (fee.amountPaise !== input.acceptedVisitFeePaise) throw new AppError('PRICE_CHANGED', { details: { visitFeePaise: fee.amountPaise } });
    // A retried request must not leave a second snapshot: snapshot only when the client request is new.
    const existing = (await this.#d.pool.query(SQL.jobByClientRequest, [k.customerUserId, input.clientRequestId])).rows[0] as Row | undefined;
    const snapshot = existing ? null : await this.#d.pricing.snapshotVisitFee(input.serviceTypeId, address.cityId, now);
    if (!existing && (!snapshot || snapshot.amountPaise !== input.acceptedVisitFeePaise)) {
      throw new AppError('PRICE_CHANGED', { details: { visitFeePaise: snapshot?.amountPaise ?? fee.amountPaise } });
    }

    return withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `${k.by.type === 'ADMIN' ? 'admin' : 'user'}:${k.by.id ?? ''}`, key: idempotencyKey,
      endpoint: k.endpoint, body: { ...input, customerUserId: k.customerUserId } }, async () => {
      await c.query(SQL.bookingLock, [k.customerUserId]);
      const again = (await c.query(SQL.jobByClientRequest, [k.customerUserId, input.clientRequestId])).rows[0] as Row | undefined;
      if (again) return { status: 200, body: await this.#jobSummary(c, again['id'] as string) };
      if (!input.confirmSeparate) {
        const dup = (await c.query(SQL.possibleDuplicate, [k.customerUserId, input.addressId, input.serviceTypeId])).rows[0] as Row | undefined;
        if (dup) throw new AppError('POSSIBLE_DUPLICATE', { details: { existingJobId: dup['id'] as string } });
      }
      if (!snapshot) throw new AppError('INVALID_STATE');
      await this.#context(c, k.by, meta);
      const jobId = newId();
      const visitId = newId();
      await c.query(SQL.insertJob, [jobId, newPublicRef(), k.customerUserId, address.cityId, address.zoneId, address.localityId, input.serviceTypeId,
        input.symptomCodes, input.addressId, address.snapshot, k.jobChannel, input.paymentPreference, input.onsiteAdult, k.by.type, k.by.id,
        k.verified, input.clientRequestId, snapshot.snapshotId, now]);
      // The start code stays unknown until the customer asks for it (issueStartCode); only its HMAC is stored.
      await c.query(SQL.insertVisit, [visitId, jobId, address.cityId, address.localityId, input.serviceTypeId, window.start, window.end, window.urgency,
        this.#codeHash(visitId, 'start', numericCode(6)), numericCode(4), now]);
      await this.#schedule(c, visitId, 'matchStart', matchStartAt(window, window.urgency, now, this.#d.policy));
      await this.#event(c, 'JobRequested', 'Job', jobId, 0, address.cityId, { jobId, visitId, serviceTypeId: input.serviceTypeId }, meta);
      const body = await this.#jobSummary(c, jobId);
      await this.#audit(c, { actorType: k.by.type, actorId: k.by.id, actorSessionId: actor.sessionId ?? null, action: 'job.created',
        resourceType: 'jobs.job', resourceId: jobId, cityId: address.cityId, outcome: 'SUCCESS',
        changeSummary: { channel: k.jobChannel, customerVerified: k.verified, urgency: window.urgency } }, meta);
      return { status: 201, body };
    }));
  }

  async #jobSummary(q: pg.ClientBase | pg.Pool, jobId: string) {
    const j = (await q.query(SQL.job, [jobId])).rows[0] as Row;
    const visits = (await q.query(SQL.visitsOfJob, [jobId])).rows as Row[];
    return {
      jobId, publicRef: j['public_ref'] as string, status: j['status'] as string, customerVerified: j['customer_verified'] as boolean,
      visits: visits.map((v) => ({ visitId: v['id'] as string, status: v['status'] as string, urgency: v['urgency'] as string,
        window: { start: (v['window_start'] as Date).toISOString(), end: (v['window_end'] as Date).toISOString() }, technicianAssigned: v['assigned'] === true })),
    };
  }

  /** GET /v1/customer/jobs/{jobId}: owner only (404 otherwise). */
  async getJob(actor: Actor, jobId: string) {
    const j = UUID.test(jobId) ? ((await this.#d.pool.query(SQL.job, [jobId])).rows[0] as Row | undefined) : undefined;
    this.#require(actor, 'jobs.job.read', { ownerUserId: (j?.['customer_user_id'] as string | undefined) ?? null });
    const summary = await this.#jobSummary(this.#d.pool, jobId);
    const cancellable = ['REQUESTED', 'IN_DIAGNOSIS'].includes(summary.status)
      && summary.visits.some((v) => ['PLANNED', 'MATCHING', 'UNFULFILLED', 'ASSIGNED', 'EN_ROUTE'].includes(v.status));
    return { ...summary, actions: cancellable ? ['CANCEL'] : [] };
  }

  /** The customer's start code (06 §3): re-issued on request before arrival; the attempt counter is kept, a locked code stays locked. */
  async issueStartCode(actor: Actor, visitId: string, meta: RequestMeta): Promise<{ startCode: string }> {
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    this.#require(actor, 'jobs.visit.start_code', { ownerUserId: (v?.['customer_user_id'] as string | undefined) ?? null });
    return withTransaction(this.#d.pool, async (c) => {
      const locked = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      if (!['PLANNED', 'MATCHING', 'UNFULFILLED', 'ASSIGNED', 'EN_ROUTE'].includes(locked['status'] as string)) throw new AppError('INVALID_STATE');
      if ((locked['start_code_attempts'] as number) >= this.#d.policy.codeMaxAttempts) throw new AppError('CODE_LOCKED');
      const code = numericCode(4);
      await c.query(SQL.setStartCode, [visitId, this.#codeHash(visitId, 'start', code), this.#now()]);
      await this.#audit(c, { actorType: 'CUSTOMER', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.start_code_issued',
        resourceType: 'jobs.visit', resourceId: visitId, outcome: 'SUCCESS' }, meta);
      return { startCode: code };
    });
  }

  // ---------------------------------------------------------------- cancellation (06 §10)

  async #cancellationFacts(jobId: string) {
    const j = (await this.#d.pool.query(SQL.job, [jobId])).rows[0] as Row | undefined;
    if (!j) return null;
    const visits = (await this.#d.pool.query(SQL.visitsOfJob, [jobId])).rows as Row[];
    const v = visits[visits.length - 1];
    const rules = await this.#d.pricing.lifecycleFeeRules(j['city_id'] as string, this.#now());
    return { job: j, visit: v, rules };
  }

  #fee(visit: Row, rules: LifecycleFeeRules) {
    const stage = cancellationStage({ status: visit['status'] as VisitStatus, windowStart: visit['window_start'] as Date }, this.#now(),
      rules.cancellation.free_cancel_lead_minutes * 60_000);
    if (stage === 'NOT_CANCELLABLE') throw new AppError('INVALID_STATE');
    return { stage, ...cancellationFee(stage, rules) };
  }

  /** GET /v1/customer/jobs/{jobId}/cancellation-preview. */
  async cancellationPreview(actor: Actor, jobId: string) {
    const f = UUID.test(jobId) ? await this.#cancellationFacts(jobId) : null;
    this.#require(actor, 'jobs.job.cancel', { ownerUserId: (f?.job['customer_user_id'] as string | undefined) ?? null });
    if (!f?.visit || !['REQUESTED', 'IN_DIAGNOSIS'].includes(f.job['status'] as string)) throw new AppError('INVALID_STATE');
    if (!f.rules) throw new AppError('INVALID_STATE');
    const fee = this.#fee(f.visit, f.rules);
    return { stage: fee.stage, feePaise: fee.customerFeePaise, technicianCompensationIncluded: fee.technicianCompensationPaise > 0 };
  }

  /** POST /v1/customer/jobs/{jobId}/cancel: the accepted fee must equal the evaluated one (no surprise charges). */
  async cancelJob(actor: Actor, jobId: string, input: { reasonCode: string; acceptedFeePaise: number }, idempotencyKey: string, meta: RequestMeta) {
    const f = UUID.test(jobId) ? await this.#cancellationFacts(jobId) : null;
    this.#require(actor, 'jobs.job.cancel', { ownerUserId: (f?.job['customer_user_id'] as string | undefined) ?? null });
    if (!f?.visit || !f.rules) throw new AppError('INVALID_STATE');
    const rules = f.rules;
    const visitId = f.visit['id'] as string;
    const cityId = f.job['city_id'] as string;
    const planned = this.#fee(f.visit, rules);
    if (planned.customerFeePaise !== input.acceptedFeePaise) throw new AppError('PRICE_CHANGED', { details: { feePaise: planned.customerFeePaise } });
    const snapshotId = await this.#d.pricing.snapshot({ rateCardId: rules.rateCardId, ruleRefs: { feeType: 'CANCELLATION' },
      inputs: { jobId, visitId, stage: planned.stage, at: this.#now().toISOString() },
      outputs: { customerFeePaise: planned.customerFeePaise, technicianCompensationPaise: planned.technicianCompensationPaise } });
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint: 'POST /v1/customer/jobs/:jobId/cancel', body: { jobId, ...input } }, async () => {
      const job = (await c.query(SQL.lockJob, [jobId])).rows[0] as Row;
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      if (!['REQUESTED', 'IN_DIAGNOSIS'].includes(job['status'] as string)) throw new AppError('INVALID_STATE');
      const fee = this.#fee(visit, rules);
      if (fee.stage !== planned.stage || fee.customerFeePaise !== input.acceptedFeePaise) {
        throw new AppError('PRICE_CHANGED', { details: { feePaise: fee.customerFeePaise } });
      }
      const now = this.#now();
      await this.#context(c, { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, meta, input.reasonCode);
      const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
      if (active) await c.query(SQL.endAssignment, [active['id'], 'RELEASED', 'CUSTOMER_CANCELLED', 'CUSTOMER', now]);
      assertTransition('visit', visit['status'] as string, 'CANCELLED');
      await c.query(SQL.setVisitTerminal, [visitId, 'CANCELLED', 'CUSTOMER_CANCELLED', new Date(now.getTime() + this.#d.policy.disclosureCloseAfterMs), now]);
      assertTransition('job', job['status'] as string, 'CANCELLED');
      await c.query(SQL.setJobStatus, [jobId, 'CANCELLED', now]);
      await c.query(SQL.insertCancellation, [jobId, visitId, 'CUSTOMER', actor.id ?? null, input.reasonCode, fee.stage, fee.customerFeePaise,
        fee.technicianCompensationPaise, snapshotId, now]);
      await this.#cancelTimers(c, visitId);
      let billId: string | null = null;
      if (fee.customerFeePaise > 0) billId = await this.#issueBill(c, jobId, visitId, 'CANCELLATION_FEE', snapshotId);
      await this.#event(c, 'JobCancelled', 'Job', jobId, (job['version'] as number) + 1, cityId,
        { jobId, visitId, stage: fee.stage, feePaise: fee.customerFeePaise, billId }, meta);
      await this.#audit(c, { actorType: 'CUSTOMER', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'job.cancelled',
        resourceType: 'jobs.job', resourceId: jobId, cityId, outcome: 'SUCCESS', reasonCode: input.reasonCode,
        changeSummary: { stage: fee.stage, feePaise: fee.customerFeePaise } }, meta);
      return { status: 200, body: { status: 'CANCELLED', stage: fee.stage, feePaise: fee.customerFeePaise, billId } };
    }));
    return r.body;
  }

  /** TCP-3 inside the jobs transaction (G-1); B4: only this coupling point may join the unit of work. */
  async #issueBill(c: pg.ClientBase, jobId: string, visitId: string, kind: BillKind, priceSnapshotId: string): Promise<string> {
    new UnitOfWork('jobs', TCPS).join('jobs', 'payments', 'issueBill');
    const bill = await this.#d.bills.issueBill(await this.#transactionContext(c), { jobId, visitId, kind, priceSnapshotId });
    return bill.billId;
  }

  // ---------------------------------------------------------------- assignment (06 §4, INV-01, INV-03)

  /** Manual ops assignment (`dispatch.assign`, city-scoped, reason required). Matching (Gate 7) uses the same path via TCP-1. */
  async assignManually(actor: Actor, visitId: string, input: { technicianUserId: string; reasonCode: string }, idempotencyKey: string, meta: RequestMeta) {
    this.#require(actor, 'jobs.visit.assign_manual', { cityId: undefined });
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    if (!v) throw new AppError('NOT_FOUND');
    this.#require(actor, 'jobs.visit.assign_manual', { cityId: v['city_id'] as string });
    const tech = await this.#d.technicians.assignable(input.technicianUserId);
    if (!tech) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'technicianUserId', code: 'NOT_ASSIGNABLE' }] });
    if (tech.cityId !== v['city_id']) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'technicianUserId', code: 'OTHER_CITY' }] });
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `admin:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint: 'POST /admin/v1/visits/:visitId/assignment', body: { visitId, ...input } }, async () => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      if (!['PLANNED', 'MATCHING', 'UNFULFILLED'].includes(visit['status'] as string)) throw new AppError('INVALID_STATE');
      await c.query(SQL.technicianLock, [input.technicianUserId]);
      const overlapping = ((await c.query(SQL.overlappingAssignments, [input.technicianUserId, visit['window_start'], visit['window_end']])).rows[0] as Row)['n'] as number;
      if (overlapping >= tech.capacity) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'technicianUserId', code: 'AT_CAPACITY' }] });
      const who: HistoryActor = { type: 'ADMIN', id: actor.id ?? null, channel: 'OPS' };
      await this.#context(c, who, meta, input.reasonCode);
      const assignmentId = await this.#assign(c, visit, { technicianUserId: input.technicianUserId, via: 'MANUAL_OPS', offerId: null,
        reasonCode: input.reasonCode, by: who }, meta);
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.assigned',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode,
        changeSummary: { assignedVia: 'MANUAL_OPS', assignmentId } }, meta);
      return { status: 200, body: { assignmentId, visitStatus: 'ASSIGNED' } };
    }));
    return r.body;
  }

  /** Visit (PLANNED / MATCHING / UNFULFILLED, locked) → ASSIGNED with a new ACTIVE assignment; job REQUESTED → IN_DIAGNOSIS. */
  async #assign(c: pg.ClientBase, visit: Row, a: { technicianUserId: string; via: 'MANUAL_OPS' | 'CASCADE_OFFER' | 'DIRECT_OFFER'; offerId: string | null;
    reasonCode: string | null; by: HistoryActor }, meta: RequestMeta | null): Promise<string> {
    const now = this.#now();
    const visitId = visit['id'] as string;
    let status = visit['status'] as string;
    if (status !== 'MATCHING') {
      assertTransition('visit', status, 'MATCHING');
      await c.query(SQL.setVisitMatching, [visitId, now]);
      status = 'MATCHING';
    }
    const assignmentId = newId();
    await c.query(SQL.insertAssignment, [assignmentId, visitId, a.technicianUserId, a.offerId, a.via, a.by.type, a.by.id ?? a.technicianUserId, a.reasonCode, now]);
    assertTransition('visit', status, 'ASSIGNED');
    const windowStart = visit['window_start'] as Date;
    await c.query(SQL.setVisitAssigned, [visitId, new Date(Math.max(now.getTime(), windowStart.getTime() - this.#d.policy.disclosureOpenLeadMs)), now]);
    const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
    if (job['status'] === 'REQUESTED') await c.query(SQL.setJobStatus, [visit['job_id'], 'IN_DIAGNOSIS', now]);
    await this.#cancelTimers(c, visitId, ['matchStart', 'matchSla']);
    await this.#schedule(c, visitId, 'techNoShow', new Date(Math.max(now.getTime(), windowStart.getTime() + this.#d.policy.techNoShowGraceMs)));
    await this.#event(c, 'VisitAssigned', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string,
      { visitId, assignmentId, assignedVia: a.via }, meta);
    return assignmentId;
  }

  // ---------------------------------------------------------------- technician actions (04 §10)

  async #assigneeVisit(actor: Actor, visitId: string, action: 'jobs.visit.read_assigned' | 'jobs.visit.act') {
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    const a = v && actor.id ? ((await this.#d.pool.query(SQL.latestAssignmentOf, [visitId, actor.id])).rows[0] as Row | undefined) : undefined;
    const isAssignee = action === 'jobs.visit.act' ? a?.['status'] === 'ACTIVE' : a !== undefined;
    this.#require(actor, action, { isAssignee });
    return { visit: v as Row, assignment: a as Row };
  }

  /** GET /v1/technician/visits/{visitId}: stage-gated (02 §5). L2 fields are logged to compliance before they are returned. */
  async getAssignedVisit(actor: Actor, visitId: string) {
    const { visit: v, assignment: a } = await this.#assigneeVisit(actor, visitId, 'jobs.visit.read_assigned');
    const closes = v['disclosure_closes_at'] as Date | null;
    const d = disclosure({
      assignment: { status: a['status'] as never, acceptedAt: a['created_at'] as Date, endedAt: (a['ended_at'] as Date | null) ?? null },
      visit: { status: v['status'] as VisitStatus, windowStart: v['window_start'] as Date,
        terminalAt: closes ? new Date(closes.getTime() - this.#d.policy.disclosureCloseAfterMs) : null },
      customerVerified: v['customer_verified'] === true, now: this.#now(),
    }, this.#d.policy);
    if (d.level === 'NONE') throw new AppError('NOT_FOUND');
    const base = { visitId, jobRef: v['public_ref'] as string, status: v['status'] as string, disclosureLevel: d.level as DisclosureLevel,
      serviceTypeId: v['required_service_type_id'] as string, locality: { id: v['locality_id'] as string } };
    if (d.level === 'L3') return { ...base, date: (v['window_start'] as Date).toISOString().slice(0, 10) };
    const active = a['status'] === 'ACTIVE';
    const repair = (v['purposes'] as string[]).includes('REPAIR');
    const actions = !active ? [] : v['status'] === 'ASSIGNED' ? ['DEPART', 'ARRIVE', 'RELEASE'] : v['status'] === 'EN_ROUTE' ? ['ARRIVE', 'START_WAIT', 'RELEASE']
      : v['status'] === 'IN_PROGRESS' ? (repair ? ['DIAGNOSE', 'COMPLETE'] : ['DIAGNOSE', 'CHECKOUT']) : [];
    const l1 = { ...base, window: { start: (v['window_start'] as Date).toISOString(), end: (v['window_end'] as Date).toISOString() },
      symptomCodes: v['symptom_codes'] as string[], actions, disclosureOpensAt: d.opensAt?.toISOString() ?? null };
    if (d.level === 'L1') return l1;
    await this.#d.recordDisclosure({ visitId, viewerType: 'TECHNICIAN', viewerId: actor.id ?? '', dataKind: 'EXACT_ADDRESS', channel: 'APP' });
    const address = await this.#d.addresses.openAddressSnapshot(v['customer_user_id'] as string, v['address_snapshot_enc'] as Buffer);
    return { ...l1, location: { addressText: [address.line1, address.line2].filter(Boolean).join(', '), landmark: address.landmark,
      accessNotes: address.accessNotes }, disclosureClosesAt: d.closesAt?.toISOString() ?? null };
  }

  async #technicianCommand<T>(actor: Actor, visitId: string, endpoint: string, body: unknown, idempotencyKey: string, meta: RequestMeta,
    fn: (c: pg.ClientBase, visit: Row) => Promise<{ status: number; body: T }>): Promise<T> {
    await this.#assigneeVisit(actor, visitId, 'jobs.visit.act');
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint, body: { visitId, body }, ttlMs: TECH_IDEMPOTENCY_TTL_MS }, async () => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
      if (active?.['technician_user_id'] !== actor.id) throw new AppError('NOT_FOUND'); // released meanwhile
      return fn(c, visit);
    }));
    return r.body;
  }

  /** POST …/depart: ASSIGNED → EN_ROUTE; repeating it is a no-op. */
  async depart(actor: Actor, visitId: string, idempotencyKey: string, meta: RequestMeta) {
    return this.#technicianCommand(actor, visitId, 'POST /v1/technician/visits/:visitId/depart', {}, idempotencyKey, meta, async (c, visit) => {
      if (visit['status'] === 'EN_ROUTE') return { status: 200, body: { visitStatus: 'EN_ROUTE' } };
      assertOrInvalid('visit', visit['status'] as string, 'EN_ROUTE');
      await this.#context(c, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' }, meta);
      await this.#repairVisitMoves(c, visit, 'DEPART');
      await c.query(SQL.setVisitDeparted, [visitId, this.#now()]);
      await this.#event(c, 'TechnicianDeparted', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string, { visitId }, meta);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.departed',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS' }, meta);
      return { status: 200, body: { visitStatus: 'EN_ROUTE' } };
    });
  }

  /**
   * POST …/arrive with the customer's start code (INV-14). A wrong code is counted and committed (5 attempts, then the
   * code locks and ops is alerted); the response for that Idempotency-Key is the same error on replay.
   */
  async arrive(actor: Actor, visitId: string, input: { startCode: string }, idempotencyKey: string, meta: RequestMeta) {
    const v0 = (await this.#assigneeVisit(actor, visitId, 'jobs.visit.act')).visit;
    const rules = await this.#d.pricing.lifecycleFeeRules(v0['city_id'] as string, this.#now());
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const idem = { actorKey: `user:${actor.id ?? ''}`, idemKey: idempotencyKey, endpoint: 'POST /v1/technician/visits/:visitId/arrive',
        requestHash: sha256(canonical({ visitId, startCode: input.startCode })), now: this.#now(), ttlMs: TECH_IDEMPOTENCY_TTL_MS };
      let start;
      try {
        start = await beginIdempotent(c, idem);
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          throw error.reason === 'KEY_REUSED' ? new AppError('IDEMPOTENCY_KEY_REUSED') : new AppError('REQUEST_IN_PROGRESS', { retryAfterSec: 1 });
        }
        throw error;
      }
      if (start.kind === 'REPLAY') return { replay: start };
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
      if (active?.['technician_user_id'] !== actor.id) throw new AppError('NOT_FOUND');
      if (visit['status'] === 'ON_SITE' || visit['status'] === 'IN_PROGRESS') {
        const body = { visitStatus: 'IN_PROGRESS' };
        await completeIdempotent(c, idem, 200, body);
        return { ok: body };
      }
      if (visit['status'] !== 'ASSIGNED' && visit['status'] !== 'EN_ROUTE') throw new AppError('INVALID_STATE');
      const max = this.#d.policy.codeMaxAttempts;
      const fail = async (code: 'CODE_INCORRECT' | 'CODE_LOCKED', details: Record<string, number>) => {
        await completeIdempotent(c, idem, code === 'CODE_LOCKED' ? 423 : 400, { code, details });
        return { error: new AppError(code, { details }) };
      };
      if ((visit['start_code_attempts'] as number) >= max) return fail('CODE_LOCKED', { attemptsLeft: 0 });
      if (!constantTimeEqual(this.#codeHash(visitId, 'start', input.startCode), visit['start_code_hash'] as Buffer)) {
        const attempts = ((await c.query(SQL.bumpStartCodeAttempts, [visitId, this.#now()])).rows[0] as Row)['start_code_attempts'] as number;
        if (attempts >= max) {
          await c.query(SQL.setJobAttention, [visit['job_id'], this.#now()]);
          this.#d.logger.log('warn', 'jobs.start_code_locked', { attemptCount: attempts });
          await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.start_code_locked',
            resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'DENIED' }, meta);
          return fail('CODE_LOCKED', { attemptsLeft: 0 });
        }
        return fail('CODE_INCORRECT', { attemptsLeft: max - attempts });
      }
      const now = this.#now();
      const who: HistoryActor = { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' };
      await c.query(SQL.presenceProof, [newId(), visitId, 'START_CODE', 'APP', 'TECHNICIAN', actor.id ?? null, null, null, now]);
      if (visit['status'] === 'ASSIGNED') {
        // 06 §3 / X-35: a code entered without "depart" inserts an implicit departure (evidence level E0 only).
        await this.#context(c, who, meta, 'IMPLICIT_DEPARTURE');
        await this.#repairVisitMoves(c, visit, 'DEPART');
        await c.query(SQL.setVisitDeparted, [visitId, now]);
      }
      await this.#context(c, who, meta);
      await c.query(SQL.setVisitArrived, [visitId, now]);
      await c.query(SQL.setVisitWorkStarted, [visitId, now]);
      await this.#repairVisitMoves(c, visit, 'START');
      const wait = (await c.query(SQL.openWait, [visitId])).rows[0] as Row | undefined;
      let waitingFeePaise = 0;
      if (wait) {
        const minutes = (now.getTime() - (wait['started_at'] as Date).getTime()) / 60_000;
        const fee = rules ? waitingFee(minutes, rules) : { billableMinutes: 0, customerFeePaise: 0 };
        waitingFeePaise = fee.customerFeePaise;
        await c.query(SQL.endWait, [wait['id'], now, 'CUSTOMER_ARRIVED', fee.billableMinutes, fee.customerFeePaise]);
      }
      await this.#cancelTimers(c, visitId, ['techNoShow', 'customerNoShow']);
      await this.#schedule(c, visitId, 'overrun', new Date(now.getTime() + this.#d.policy.maxVisitMs));
      await this.#event(c, 'TechnicianArrived', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string, { visitId }, meta);
      const body = { visitStatus: 'IN_PROGRESS', waitingFeePaise };
      await completeIdempotent(c, idem, 200, body);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.arrived',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS',
        changeSummary: { implicitDeparture: visit['status'] === 'ASSIGNED' } }, meta);
      return { ok: body };
    });
    if ('error' in outcome) throw outcome.error;
    if ('replay' in outcome) {
      const b = outcome.replay.body as { code?: string; details?: Record<string, number> };
      if (outcome.replay.status >= 400) throw new AppError((b.code ?? 'INTERNAL') as never, b.details ? { details: b.details } : {});
      return outcome.replay.body as { visitStatus: string };
    }
    return outcome.ok;
  }

  /** POST …/wait/start (06 §3): evidence = a location snapshot near the visit's locality (call evidence: Gate 10). */
  async startWait(actor: Actor, visitId: string, input: { location: { lat: number; lng: number; accuracyM: number } }, idempotencyKey: string, meta: RequestMeta) {
    const v0 = (await this.#assigneeVisit(actor, visitId, 'jobs.visit.act')).visit;
    const metres = await this.#d.localities.metresFromLocality(v0['locality_id'] as string, input.location);
    if (metres === null || metres > 2_000 || input.location.accuracyM > 200) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'location', code: 'NOT_NEAR_LOCALITY' }] });
    }
    return this.#technicianCommand(actor, visitId, 'POST /v1/technician/visits/:visitId/wait/start', input, idempotencyKey, meta, async (c, visit) => {
      if (visit['status'] !== 'EN_ROUTE') throw new AppError('INVALID_STATE');
      if ((await c.query(SQL.openWait, [visitId])).rows.length > 0) return { status: 200, body: { waiting: true } };
      const now = this.#now();
      await c.query(SQL.presenceProof, [newId(), visitId, 'LOCATION_SNAPSHOT', 'APP', 'TECHNICIAN', actor.id ?? null, null, null, now]);
      await this.#startWait(c, visit, 'LOCATION_SNAPSHOT', now);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.wait_started',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS', changeSummary: { evidence: 'LOCATION_SNAPSHOT' } }, meta);
      return { status: 200, body: { waiting: true } };
    });
  }

  async #startWait(c: pg.ClientBase, visit: Row, evidence: 'LOCATION_SNAPSHOT' | 'OPS_CONFIRMED', now: Date): Promise<void> {
    const visitId = visit['id'] as string;
    await c.query(SQL.insertWait, [newId(), visitId, now, evidence]);
    await cancelTimer(c, timerKey(visitId, 'techNoShow'));
    await this.#schedule(c, visitId, 'customerNoShow', new Date(now.getTime() + this.#d.policy.waitGraceMs));
  }

  /** Ops-confirmed wait (06 §3: "or ops confirmation"), `dispatch.assign` for the city. */
  async opsConfirmWait(actor: Actor, visitId: string, input: { reasonCode: string }, idempotencyKey: string, meta: RequestMeta) {
    this.#require(actor, 'jobs.visit.ops_wait', { cityId: undefined });
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    if (!v) throw new AppError('NOT_FOUND');
    this.#require(actor, 'jobs.visit.ops_wait', { cityId: v['city_id'] as string });
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `admin:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint: 'POST /admin/v1/visits/:visitId/wait', body: { visitId, ...input } }, async () => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      if (visit['status'] !== 'EN_ROUTE') throw new AppError('INVALID_STATE');
      if ((await c.query(SQL.openWait, [visitId])).rows.length === 0) await this.#startWait(c, visit, 'OPS_CONFIRMED', this.#now());
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.wait_started',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode,
        changeSummary: { evidence: 'OPS_CONFIRMED' } }, meta);
      return { status: 200, body: { waiting: true } };
    }));
    return r.body;
  }

  /** POST …/release (06 §4): never blocked; inside the free-release lead it is recorded as a late release. */
  async release(actor: Actor, visitId: string, input: { reasonCode: string; safetyConcern?: boolean | undefined }, idempotencyKey: string, meta: RequestMeta) {
    return this.#technicianCommand(actor, visitId, 'POST /v1/technician/visits/:visitId/release', input, idempotencyKey, meta, async (c, visit) => {
      if (visit['status'] !== 'ASSIGNED' && visit['status'] !== 'EN_ROUTE') throw new AppError('INVALID_STATE');
      const now = this.#now();
      const late = now.getTime() > (visit['window_start'] as Date).getTime() - this.#d.policy.freeReleaseLeadMs;
      const reason = input.safetyConcern ? 'SAFETY_CONCERN' : input.reasonCode;
      await this.#context(c, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' }, meta, late && !input.safetyConcern ? 'LATE_RELEASE' : reason);
      await this.#backToMatching(c, visit, { assignmentStatus: 'RELEASED', reason, by: 'TECHNICIAN' }, meta);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'assignment.released',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS', reasonCode: reason,
        changeSummary: { lateRelease: late } }, meta);
      return { status: 200, body: { visitStatus: 'MATCHING', lateRelease: late } };
    });
  }

  /** Ends the ACTIVE assignment and returns the visit to MATCHING (job IN_DIAGNOSIS → REQUESTED: re-matched). */
  async #backToMatching(c: pg.ClientBase, visit: Row, end: { assignmentStatus: 'RELEASED' | 'NO_SHOW'; reason: string; by: 'TECHNICIAN' | 'SYSTEM' },
    meta: RequestMeta | null): Promise<void> {
    const now = this.#now();
    const visitId = visit['id'] as string;
    const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
    if (active) await c.query(SQL.endAssignment, [active['id'], end.assignmentStatus, end.reason, end.by, now]);
    const wait = (await c.query(SQL.openWait, [visitId])).rows[0] as Row | undefined;
    if (wait) await c.query(SQL.endWait, [wait['id'], now, 'CANCELLED', 0, 0]);
    assertTransition('visit', visit['status'] as string, 'MATCHING');
    await c.query(SQL.setVisitMatching, [visitId, now]);
    const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
    if (job['status'] === 'IN_DIAGNOSIS') await c.query(SQL.setJobStatus, [visit['job_id'], 'REQUESTED', now]);
    if (job['status'] === 'REPAIR_IN_PROGRESS' && (visit['purposes'] as string[]).includes('REPAIR')) {
      await c.query(SQL.setJobStatus, [visit['job_id'], 'REPAIR_PENDING', now]);
    }
    await this.#cancelTimers(c, visitId, ['techNoShow', 'customerNoShow']);
    await this.#schedule(c, visitId, 'matchSla', new Date(now.getTime() + this.#slaMs(visit)));
    await this.#event(c, end.assignmentStatus === 'NO_SHOW' ? 'AssignmentNoShow' : 'AssignmentReleased', 'Visit', visitId,
      (visit['version'] as number) + 1, visit['city_id'] as string, { visitId, reason: end.reason }, meta);
  }

  #slaMs(visit: Row): number {
    return visit['urgency'] === 'ASAP' ? this.#d.policy.asapMatchSlaMs : this.#d.policy.scheduledMatchSlaMs;
  }

  // ---------------------------------------------------------------- ops: customer confirmation (G-4)

  /** Ops confirmed the booking by a call to the registered number (logged): L2 may open (G-4). */
  async confirmCustomerByCall(actor: Actor, jobId: string, input: { reasonCode: string }, meta: RequestMeta) {
    this.#require(actor, 'jobs.job.confirm_customer', { cityId: undefined });
    const j = UUID.test(jobId) ? ((await this.#d.pool.query(SQL.job, [jobId])).rows[0] as Row | undefined) : undefined;
    if (!j) throw new AppError('NOT_FOUND');
    this.#require(actor, 'jobs.job.confirm_customer', { cityId: j['city_id'] as string });
    await withTransaction(this.#d.pool, async (c) => {
      const changed = (await c.query(SQL.confirmCustomer, [jobId, this.#now()])).rowCount === 1;
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'job.customer_confirmed',
        resourceType: 'jobs.job', resourceId: jobId, cityId: j['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode,
        changeSummary: { changed } }, meta);
    });
    return { customerVerified: true };
  }

  // ---------------------------------------------------------------- ops presence override (ADR-026 #7, executed by a change request)

  /** Validates an arrival override proposal; returns the visit's city (for the change-request scope). */
  async arrivalOverrideTarget(visitId: string): Promise<{ cityId: string } | null> {
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    if (!v || (v['status'] !== 'ASSIGNED' && v['status'] !== 'EN_ROUTE')) return null;
    const active = (await this.#d.pool.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
    return active ? { cityId: v['city_id'] as string } : null;
  }

  /** Executes an approved arrival override (INV-14 audited override); idempotent. */
  async executeArrivalOverride(changeRequestId: string, input: { visitId: string; reasonCode: string }, ctx: { actorId: string; requestId: string }): Promise<void> {
    await withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [input.visitId])).rows[0] as Row | undefined;
      if (!visit) throw new AppError('INVALID_STATE');
      if (visit['status'] === 'ON_SITE' || visit['status'] === 'IN_PROGRESS') return;
      if (visit['status'] !== 'ASSIGNED' && visit['status'] !== 'EN_ROUTE') throw new AppError('INVALID_STATE');
      const now = this.#now();
      const meta = { requestId: ctx.requestId, clientIp: '0.0.0.0' };
      const who: HistoryActor = { type: 'ADMIN', id: ctx.actorId, channel: 'OPS' };
      await c.query(SQL.presenceProof, [newId(), input.visitId, 'OPS_OVERRIDE_ARRIVAL', 'OPS', 'ADMIN', ctx.actorId, changeRequestId, input.reasonCode, now]);
      await this.#context(c, who, meta, input.reasonCode);
      if (visit['status'] === 'ASSIGNED') {
        await this.#repairVisitMoves(c, visit, 'DEPART');
        await c.query(SQL.setVisitDeparted, [input.visitId, now]);
      }
      await c.query(SQL.setVisitArrived, [input.visitId, now]);
      await c.query(SQL.setVisitWorkStarted, [input.visitId, now]);
      await this.#repairVisitMoves(c, visit, 'START');
      await this.#cancelTimers(c, input.visitId, ['techNoShow', 'customerNoShow']);
      await this.#schedule(c, input.visitId, 'overrun', new Date(now.getTime() + this.#d.policy.maxVisitMs));
      await this.#audit(c, { actorType: 'ADMIN', actorId: ctx.actorId, action: 'visit.arrival_overridden', resourceType: 'jobs.visit', resourceId: input.visitId,
        cityId: visit['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode, changeSummary: { changeRequestId } }, null);
    });
  }

  // ---------------------------------------------------------------- Gate 6: facade reads for the diagnosis module (ADR-027)

  /** The visit a diagnosis is captured on: state, purposes, its job and the ACTIVE technician. Read-only. */
  async diagnosisVisitFacts(visitId: string): Promise<DiagnosisVisitFacts | null> {
    if (!UUID.test(visitId)) return null;
    const r = (await this.#d.pool.query(SQL.diagnosisVisitFacts, [visitId])).rows[0] as Row | undefined;
    if (!r) return null;
    return {
      visitId, jobId: r['job_id'] as string, cityId: r['city_id'] as string, status: r['status'] as string, purposes: r['purposes'] as string[],
      repairOrderId: (r['repair_order_id'] as string | null) ?? null, serviceTypeId: r['service_type_id'] as string,
      customerUserId: r['customer_user_id'] as string, jobStatus: r['job_status'] as string, visitFeeSnapshotId: r['visit_fee_snapshot_id'] as string,
      customerVerified: r['customer_verified'] === true, activeTechnicianUserId: (r['active_technician_user_id'] as string | null) ?? null,
    };
  }

  /** The job a quote belongs to (owner, city, status, visit-fee snapshot, open repair order). Read-only. */
  async quoteJobFacts(jobId: string): Promise<QuoteJobFacts | null> {
    if (!UUID.test(jobId)) return null;
    const r = (await this.#d.pool.query(SQL.quoteJobFacts, [jobId])).rows[0] as Row | undefined;
    if (!r) return null;
    return {
      jobId, customerUserId: r['customer_user_id'] as string, cityId: r['city_id'] as string, status: r['status'] as string,
      serviceTypeId: r['service_type_id'] as string, visitFeeSnapshotId: r['visit_fee_snapshot_id'] as string, customerVerified: r['customer_verified'] === true,
      openRepairOrderId: (r['open_repair_order_id'] as string | null) ?? null, openRepairOrderStatus: (r['open_repair_order_status'] as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- Gate 6: diagnosis checkout (06 §3)

  /**
   * POST …/checkout: a diagnosis-only visit ends when a diagnosis is SUBMITTED and either a quote was presented or no
   * repair is needed. No repair needed: the job awaits payment of the visit fee (TCP-3 bill in this transaction).
   */
  async checkoutDiagnosisVisit(actor: Actor, visitId: string, idempotencyKey: string, meta: RequestMeta) {
    await this.#assigneeVisit(actor, visitId, 'jobs.visit.act');
    const facts = await this.#d.repairQuotes.diagnosisCheckout(visitId);
    if (!facts.submitted || !(facts.quotePresented || facts.noRepairNeeded)) throw new AppError('INVALID_STATE');
    return this.#technicianCommand(actor, visitId, 'POST /v1/technician/visits/:visitId/checkout', {}, idempotencyKey, meta, async (c, visit) => {
      const body = await this.#checkout(c, visit, facts.noRepairNeeded, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' }, meta, 'CHECKOUT');
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.completed',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS',
        changeSummary: { checkout: 'TECHNICIAN', noRepairNeeded: facts.noRepairNeeded } }, meta);
      return { status: 200, body };
    });
  }

  async #checkout(c: pg.ClientBase, visit: Row, noRepairNeeded: boolean, who: HistoryActor, meta: RequestMeta | null, reason: 'CHECKOUT' | 'AUTO_CHECKOUT') {
    const visitId = visit['id'] as string;
    if (visit['status'] === 'COMPLETED') return { visitStatus: 'COMPLETED', billId: null };
    const purposes = visit['purposes'] as string[];
    if (visit['status'] !== 'IN_PROGRESS' || purposes.length !== 1 || purposes[0] !== 'DIAGNOSIS') throw new AppError('INVALID_STATE');
    const now = this.#now();
    await this.#context(c, who, meta, reason);
    const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
    if (active) await c.query(SQL.endAssignment, [active['id'], 'COMPLETED', 'VISIT_COMPLETED', who.type, now]);
    assertTransition('visit', 'IN_PROGRESS', 'COMPLETED');
    await c.query(SQL.setVisitCompleted, [visitId, now, reason, new Date(now.getTime() + this.#d.policy.disclosureCloseAfterMs)]);
    await this.#cancelTimers(c, visitId);
    let billId: string | null = null;
    if (noRepairNeeded) {
      const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
      if (job['status'] === 'IN_DIAGNOSIS') {
        await c.query(SQL.setJobStatus, [job['id'], 'AWAITING_PAYMENT', now]);
        billId = await this.#issueBill(c, job['id'] as string, visitId, 'VISIT_FEE', job['visit_fee_snapshot_id'] as string);
      }
    }
    await this.#event(c, 'VisitCompleted', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string,
      { visitId, purposes: 'DIAGNOSIS', autoCheckout: reason === 'AUTO_CHECKOUT', noRepairNeeded, billId }, meta);
    return { visitStatus: 'COMPLETED', billId };
  }

  /** SYS auto-checkout 30 min (fixture, NOT FINAL) after the quote was presented, flagged `AUTO_CHECKOUT` (06 §3). */
  async onAutoCheckout(visitId: string): Promise<boolean> {
    const facts = await this.#d.repairQuotes.diagnosisCheckout(visitId);
    if (!facts.submitted || !(facts.quotePresented || facts.noRepairNeeded)) return false;
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      const purposes = (visit?.['purposes'] as string[] | undefined) ?? [];
      if (!visit || visit['status'] !== 'IN_PROGRESS' || purposes.length !== 1 || purposes[0] !== 'DIAGNOSIS') return false;
      await this.#checkout(c, visit, facts.noRepairNeeded, SYSTEM, null, 'AUTO_CHECKOUT');
      return true;
    });
  }

  // ---------------------------------------------------------------- Gate 6: quote events → repair orders (async, 01 §5)

  /** The jobs consumer of the quote events (outbox relay, worker role). Idempotent: `consumeOnce` in each transaction. */
  eventConsumer(): EventConsumer {
    return {
      name: 'jobs',
      handles: ['QuoteVersionPresented', 'QuoteApproved', 'QuoteRejected', 'QuoteExpired'],
      handle: async (e) => {
        if (e.type === 'QuoteVersionPresented') await this.#onQuotePresented(e);
        else if (e.type === 'QuoteApproved') await this.#onQuoteApproved(e);
        else await this.#onQuoteClosed(e);
      },
    };
  }

  #eventMeta(e: OutboxEvent): RequestMeta {
    return { requestId: e.correlationId, clientIp: '0.0.0.0' };
  }

  /** v(n) presented: the job awaits approval; a change order pauses the repair order (CHANGE_PENDING, 06 §7). */
  async #onQuotePresented(e: OutboxEvent): Promise<void> {
    const p = quoteEventPayload(e);
    await withTransaction(this.#d.pool, async (c) => {
      if (!(await consumeOnce(c, 'jobs', e.id))) return;
      const meta = this.#eventMeta(e);
      const job = (await c.query(SQL.lockJob, [p.jobId])).rows[0] as Row | undefined;
      if (!job) return;
      const now = this.#now();
      await this.#context(c, SYSTEM, meta, 'QUOTE_PRESENTED');
      if (p.changeOrder) {
        const ro = (await c.query(SQL.lockOpenRepairOrderOfJob, [p.jobId])).rows[0] as Row | undefined;
        if (ro?.['status'] === 'IN_PROGRESS') await c.query(SQL.setRepairOrderStatus, [ro['id'], 'CHANGE_PENDING', now]);
        if (job['status'] === 'REPAIR_IN_PROGRESS') await c.query(SQL.setJobStatus, [p.jobId, 'AWAITING_APPROVAL', now]);
        return;
      }
      if (job['status'] === 'IN_DIAGNOSIS') await c.query(SQL.setJobStatus, [p.jobId, 'AWAITING_APPROVAL', now]);
      const visit = (await c.query(SQL.lockVisit, [p.visitId])).rows[0] as Row | undefined;
      const purposes = (visit?.['purposes'] as string[] | undefined) ?? [];
      if (visit?.['status'] === 'IN_PROGRESS' && purposes.length === 1 && purposes[0] === 'DIAGNOSIS') {
        await this.#schedule(c, p.visitId, 'autoCheckout', new Date(p.presentedAt.getTime() + this.#d.policy.autoCheckoutAfterPresentationMs));
      }
    });
  }

  /**
   * QuoteApproved → repair order (06 §8). A change order moves the open order to the new version and resumes it. A
   * first approval creates the order: attached to the diagnosis visit when every same-visit guard holds (06 §3),
   * otherwise AWAITING_SCHEDULE (the customer is told why). INV-04: only an APPROVED version starts work.
   */
  async #onQuoteApproved(e: OutboxEvent): Promise<void> {
    const p = quoteEventPayload(e);
    const facts = await this.#d.repairQuotes.versionFacts(p.quoteVersionId);
    if (!facts) throw new AppError('INVALID_STATE');
    const job0 = (await this.#d.pool.query(SQL.job, [p.jobId])).rows[0] as Row | undefined;
    if (!job0) return;
    const now = this.#now();
    const rules = await this.#d.offers.getServiceRules(job0['service_type_id'] as string, job0['city_id'] as string, now);
    const qualified = await this.#d.repairSkills.repairQualified(facts.diagnosingTechnicianUserId, facts.requiredServiceTypeId,
      facts.requiredSpecializationId, now);
    await withTransaction(this.#d.pool, async (c) => {
      if (!(await consumeOnce(c, 'jobs', e.id))) return;
      const meta = this.#eventMeta(e);
      const job = (await c.query(SQL.lockJob, [p.jobId])).rows[0] as Row;
      const cityId = job['city_id'] as string;
      const open = (await c.query(SQL.lockOpenRepairOrderOfJob, [p.jobId])).rows[0] as Row | undefined;
      await this.#context(c, SYSTEM, meta, 'QUOTE_APPROVED');
      const materials = JSON.stringify(facts.materials);
      const suppliedBy = facts.materials.length > 0 ? 'TECHNICIAN' : 'NONE';
      if (open) {
        // Change order approved: the order now points to v(n+1) (history: CHANGE_PENDING → IN_PROGRESS, reason above).
        if (open['status'] === 'CHANGE_PENDING' && facts.status === 'APPROVED') {
          await c.query(SQL.setRepairOrderChangeApproved, [open['id'], facts.quoteVersionId, materials, suppliedBy, now]);
        }
        if (job['status'] === 'AWAITING_APPROVAL') await c.query(SQL.setJobStatus, [p.jobId, 'REPAIR_IN_PROGRESS', now]);
        await this.#event(c, 'RepairOrderVersionChanged', 'RepairOrder', open['id'] as string, (open['version'] as number) + 1, cityId,
          { repairOrderId: open['id'] as string, quoteVersionId: facts.quoteVersionId }, meta);
        return;
      }
      if (job['status'] !== 'AWAITING_APPROVAL' || facts.status !== 'APPROVED') return;
      const repairOrderId = newId();
      let unavailable: string | null = null;
      const visit = (await c.query(SQL.lockVisit, [facts.diagnosingVisitId])).rows[0] as Row | undefined;
      if (facts.repairPreference === 'SAME_VISIT') {
        const purposes = (visit?.['purposes'] as string[] | undefined) ?? [];
        const active = visit ? ((await c.query(SQL.activeAssignment, [visit['id']])).rows[0] as Row | undefined) : undefined;
        if (!visit || visit['status'] !== 'IN_PROGRESS' || purposes.length !== 1 || purposes[0] !== 'DIAGNOSIS'
          || active?.['technician_user_id'] !== facts.diagnosingTechnicianUserId) unavailable = 'VISIT_ENDED';
        else if (rules?.same_visit_repair_allowed !== true) unavailable = 'NOT_ALLOWED_FOR_SERVICE';
        else if (!qualified) unavailable = 'TECHNICIAN_NOT_QUALIFIED';
        else if (!facts.materialAvailableNow) unavailable = 'MATERIAL_NOT_AVAILABLE';
        else if (!facts.decidedAt || facts.decidedAt.getTime() - facts.presentedAt.getTime() > this.#d.policy.sameVisitMaxWaitMs) unavailable = 'APPROVAL_TOO_LATE';
      }
      if (facts.repairPreference === 'SAME_VISIT' && unavailable === null && visit) {
        await c.query(SQL.insertRepairOrder, [repairOrderId, p.jobId, facts.quoteId, facts.quoteVersionId, facts.requiredServiceTypeId,
          facts.requiredSpecializationId, 'SAME_VISIT', facts.diagnosingTechnicianUserId, facts.allowFallback, null, null, materials, suppliedBy, 'IN_PROGRESS', now]);
        const attached = await c.query(SQL.attachRepairToVisit, [visit['id'], repairOrderId, this.#codeHash(visit['id'] as string, 'completion', numericCode(6)), now]);
        if (attached.rowCount !== 1) throw new AppError('INVALID_STATE');
        await this.#cancelTimers(c, visit['id'] as string, ['autoCheckout']);
        await c.query(SQL.setJobStatus, [p.jobId, 'REPAIR_IN_PROGRESS', now]);
        await this.#event(c, 'RepairOrderCreated', 'RepairOrder', repairOrderId, 0, cityId,
          { repairOrderId, jobId: p.jobId, sameVisit: true, visitId: visit['id'] as string }, meta);
        return;
      }
      // Separate repair visit. A same-visit wish that failed its guard falls back to the diagnosing technician later when
      // they are qualified, else to a recommended specialist (02 §4); the reason goes to the customer.
      let preference = facts.repairPreference ?? 'RECOMMENDED_SPECIALIST';
      let preferred = facts.preferredTechnicianUserId;
      if (preference === 'SAME_VISIT') {
        preference = qualified ? 'SAME_TECHNICIAN' : 'RECOMMENDED_SPECIALIST';
        preferred = qualified ? facts.diagnosingTechnicianUserId : null;
      }
      if (preference === 'SAME_TECHNICIAN' && !preferred) preference = 'RECOMMENDED_SPECIALIST';
      await c.query(SQL.insertRepairOrder, [repairOrderId, p.jobId, facts.quoteId, facts.quoteVersionId, facts.requiredServiceTypeId, facts.requiredSpecializationId,
        preference, preference === 'SAME_TECHNICIAN' ? preferred : null, facts.allowFallback, facts.preferredWindow?.start ?? null, facts.preferredWindow?.end ?? null,
        materials, suppliedBy, 'AWAITING_SCHEDULE', now]);
      await c.query(SQL.setJobStatus, [p.jobId, 'REPAIR_PENDING', now]);
      await this.#scheduleRepairTimer(c, repairOrderId, 'repairUnscheduled', new Date(now.getTime() + this.#d.policy.repairUnscheduledMs));
      await this.#event(c, 'RepairOrderCreated', 'RepairOrder', repairOrderId, 0, cityId,
        { repairOrderId, jobId: p.jobId, sameVisit: false, sameVisitUnavailableReason: unavailable }, meta);
    });
  }

  /**
   * QuoteRejected / QuoteExpired (06 §2, §7): a change order leaves the approved version in force (the order resumes); a
   * first quote closes the work: the job awaits payment of the visit fee (TCP-3 bill in this transaction).
   */
  async #onQuoteClosed(e: OutboxEvent): Promise<void> {
    const p = quoteEventPayload(e);
    await withTransaction(this.#d.pool, async (c) => {
      if (!(await consumeOnce(c, 'jobs', e.id))) return;
      const meta = this.#eventMeta(e);
      const job = (await c.query(SQL.lockJob, [p.jobId])).rows[0] as Row | undefined;
      if (!job) return;
      const now = this.#now();
      const open = (await c.query(SQL.lockOpenRepairOrderOfJob, [p.jobId])).rows[0] as Row | undefined;
      await this.#context(c, SYSTEM, meta, e.type === 'QuoteRejected' ? 'QUOTE_REJECTED' : 'QUOTE_EXPIRED');
      if (p.changeOrder) {
        if (open?.['status'] === 'CHANGE_PENDING') await c.query(SQL.setRepairOrderStatus, [open['id'], 'IN_PROGRESS', now]);
        if (job['status'] === 'AWAITING_APPROVAL' && open) await c.query(SQL.setJobStatus, [p.jobId, 'REPAIR_IN_PROGRESS', now]);
        return;
      }
      if (job['status'] !== 'AWAITING_APPROVAL' || open) return;
      await c.query(SQL.setJobStatus, [p.jobId, 'AWAITING_PAYMENT', now]);
      const billId = await this.#issueBill(c, p.jobId, p.visitId, 'VISIT_FEE', job['visit_fee_snapshot_id'] as string);
      await this.#event(c, 'JobAwaitingPayment', 'Job', p.jobId, (job['version'] as number) + 1, job['city_id'] as string,
        { jobId: p.jobId, billId, reason: e.type === 'QuoteRejected' ? 'QUOTE_REJECTED' : 'QUOTE_EXPIRED' }, meta);
    });
  }

  // ---------------------------------------------------------------- Gate 6: repair orders (04 §12, 06 §8)

  async #ownedRepairOrder(actor: Actor, repairOrderId: string, action: string): Promise<Row> {
    const ro = UUID.test(repairOrderId) ? ((await this.#d.pool.query(SQL.repairOrder, [repairOrderId])).rows[0] as Row | undefined) : undefined;
    this.#require(actor, action, { ownerUserId: (ro?.['customer_user_id'] as string | undefined) ?? null });
    return ro as Row;
  }

  async #visitFeeOf(row: Row): Promise<number> {
    const outputs = await this.#d.pricing.snapshotOutputs(row['visit_fee_snapshot_id'] as string);
    const fee = outputs?.['visitFeePaise'];
    if (typeof fee !== 'number') throw new AppError('INVALID_STATE');
    return fee;
  }

  /** GET /v1/customer/repair-orders/{id}: owner only (404 otherwise). */
  async getRepairOrder(actor: Actor, repairOrderId: string) {
    const ro = await this.#ownedRepairOrder(actor, repairOrderId, 'jobs.repair_order.read');
    const visits = (await this.#d.pool.query(SQL.visitsOfRepairOrder, [repairOrderId])).rows as Row[];
    const status = ro['status'] as string;
    const cancellable = (status === 'AWAITING_SCHEDULE' || status === 'SCHEDULED') && ro['job_status'] === 'REPAIR_PENDING';
    return {
      repairOrderId, status, performerPreference: ro['performer_preference'] as string, allowFallback: ro['allow_fallback'] as boolean,
      materials: (ro['materials_required'] as QuotedMaterial[]).map((m) => ({ materialId: m.materialId, qty: milliToString(m.qtyMilli) })),
      visits: visits.map((v) => ({ visitId: v['id'] as string, status: v['status'] as string })),
      nextAction: status === 'AWAITING_SCHEDULE' ? 'SCHEDULE' : null,
      ...(cancellable ? { cancellationFeePaise: await this.#visitFeeOf(ro) } : {}),
    };
  }

  /**
   * POST …/schedule (04 §12): the customer picks a window (and may switch between the same technician, when the order
   * names one, and a recommended specialist). Creates the repair visit (PLANNED, new start and completion codes); the
   * order is SCHEDULED and matching starts per the lead time (manual ops assignment until Gate 7).
   */
  async scheduleRepair(actor: Actor, repairOrderId: string, input: { timing: Timing; performerPreference?: 'SAME_TECHNICIAN' | 'RECOMMENDED_SPECIALIST' | undefined;
    allowFallback?: boolean | undefined }, idempotencyKey: string, meta: RequestMeta) {
    const ro = await this.#ownedRepairOrder(actor, repairOrderId, 'jobs.repair_order.schedule');
    const preference = input.performerPreference ?? (ro['performer_preference'] === 'SAME_TECHNICIAN' ? 'SAME_TECHNICIAN' : 'RECOMMENDED_SPECIALIST');
    const preferred = preference === 'SAME_TECHNICIAN' ? ((ro['preferred_technician_user_id'] as string | null) ?? null) : null;
    if (preference === 'SAME_TECHNICIAN' && !preferred) throw new AppError('OPTION_UNAVAILABLE');
    const now = this.#now();
    const window = bookingWindow(input.timing.type === 'ASAP' ? { type: 'ASAP' }
      : { type: 'SLOT', start: new Date(input.timing.start), end: new Date(input.timing.end) }, now, this.#d.policy);
    if (!window) throw new AppError('SLOT_UNAVAILABLE');
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint: 'POST /v1/customer/repair-orders/:repairOrderId/schedule', body: { repairOrderId, ...input } }, async () => {
      const locked = (await c.query(SQL.lockRepairOrder, [repairOrderId])).rows[0] as Row;
      if (locked['status'] !== 'AWAITING_SCHEDULE') throw new AppError('INVALID_STATE');
      const job = (await c.query(SQL.lockJob, [locked['job_id']])).rows[0] as Row;
      if (job['status'] !== 'REPAIR_PENDING') throw new AppError('INVALID_STATE');
      await this.#context(c, { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, meta);
      const visitId = newId();
      const seq = ((await c.query(SQL.nextVisitSequence, [locked['job_id']])).rows[0] as Row)['n'] as number;
      await c.query(SQL.insertRepairVisit, [visitId, locked['job_id'], job['city_id'], job['locality_id'], seq, repairOrderId, locked['required_service_type_id'],
        locked['required_specialization_id'], window.start, window.end, window.urgency, this.#codeHash(visitId, 'start', numericCode(6)),
        this.#codeHash(visitId, 'completion', numericCode(6)), numericCode(4), now]);
      await c.query(SQL.setRepairOrderScheduled, [repairOrderId, window.start, window.end, preference, preferred,
        input.allowFallback ?? (locked['allow_fallback'] as boolean), now]);
      await this.#cancelRepairTimers(c, repairOrderId);
      await this.#schedule(c, visitId, 'matchStart', matchStartAt(window, window.urgency, now, this.#d.policy));
      await this.#event(c, 'RepairOrderScheduled', 'RepairOrder', repairOrderId, (locked['version'] as number) + 1, job['city_id'] as string,
        { repairOrderId, visitId, performerPreference: preference }, meta);
      await this.#audit(c, { actorType: 'CUSTOMER', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'repair_order.scheduled',
        resourceType: 'jobs.repair_order', resourceId: repairOrderId, cityId: job['city_id'] as string, outcome: 'SUCCESS',
        changeSummary: { performerPreference: preference, urgency: window.urgency } }, meta);
      return { status: 200, body: { repairOrderId, status: 'SCHEDULED', visitId } };
    }));
    return r.body;
  }

  /**
   * POST …/cancel (04 §12, 06 §10 "after approval, before the repair visit departs"): the visit fee is due (the accepted
   * fee must equal it), the order and any repair visit not yet on the way are cancelled, the job is CANCELLED with a
   * TCP-3 bill. Once the technician is on the way the customer can't cancel this way (06 §2).
   */
  async cancelRepairOrder(actor: Actor, repairOrderId: string, input: { reasonCode: string; acceptedFeePaise: number }, idempotencyKey: string, meta: RequestMeta) {
    const ro = await this.#ownedRepairOrder(actor, repairOrderId, 'jobs.repair_order.cancel');
    const fee = await this.#visitFeeOf(ro);
    if (fee !== input.acceptedFeePaise) throw new AppError('PRICE_CHANGED', { details: { feePaise: fee } });
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
      endpoint: 'POST /v1/customer/repair-orders/:repairOrderId/cancel', body: { repairOrderId, ...input } }, async () => {
      const locked = (await c.query(SQL.lockRepairOrder, [repairOrderId])).rows[0] as Row;
      if (locked['status'] !== 'AWAITING_SCHEDULE' && locked['status'] !== 'SCHEDULED') throw new AppError('INVALID_STATE');
      const jobId = locked['job_id'] as string;
      const job = (await c.query(SQL.lockJob, [jobId])).rows[0] as Row;
      if (job['status'] !== 'REPAIR_PENDING') throw new AppError('INVALID_STATE');
      const now = this.#now();
      await this.#context(c, { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, meta, input.reasonCode);
      for (const v of (await c.query(SQL.visitsOfRepairOrder, [repairOrderId])).rows as Row[]) {
        const visit = (await c.query(SQL.lockVisit, [v['id']])).rows[0] as Row;
        if (isTerminal('visit', visit['status'] as string)) continue;
        if (!['PLANNED', 'MATCHING', 'UNFULFILLED', 'ASSIGNED'].includes(visit['status'] as string)) throw new AppError('INVALID_STATE');
        const active = (await c.query(SQL.activeAssignment, [v['id']])).rows[0] as Row | undefined;
        if (active) await c.query(SQL.endAssignment, [active['id'], 'RELEASED', 'CUSTOMER_CANCELLED', 'CUSTOMER', now]);
        await c.query(SQL.setVisitTerminal, [v['id'], 'CANCELLED', 'CUSTOMER_CANCELLED', new Date(now.getTime() + this.#d.policy.disclosureCloseAfterMs), now]);
        await this.#cancelTimers(c, v['id'] as string);
      }
      assertTransition('repair_order', locked['status'] as string, 'CANCELLED');
      await c.query(SQL.setRepairOrderStatus, [repairOrderId, 'CANCELLED', now]);
      await this.#cancelRepairTimers(c, repairOrderId);
      assertTransition('job', 'REPAIR_PENDING', 'CANCELLED');
      await c.query(SQL.setJobStatus, [jobId, 'CANCELLED', now]);
      const lastVisit = ((await c.query(SQL.visitsOfJob, [jobId])).rows as Row[])[0];
      const visitFeeSnapshot = job['visit_fee_snapshot_id'] as string;
      await c.query(SQL.insertCancellation, [jobId, null, 'CUSTOMER', actor.id ?? null, input.reasonCode, 'AFTER_APPROVAL', fee, 0, visitFeeSnapshot, now]);
      const billId = fee > 0 ? await this.#issueBill(c, jobId, (lastVisit?.['id'] as string | undefined) ?? repairOrderId, 'VISIT_FEE', visitFeeSnapshot) : null;
      await this.#event(c, 'JobCancelled', 'Job', jobId, (job['version'] as number) + 1, job['city_id'] as string,
        { jobId, repairOrderId, stage: 'AFTER_APPROVAL', feePaise: fee, billId }, meta);
      await this.#audit(c, { actorType: 'CUSTOMER', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'repair_order.cancelled',
        resourceType: 'jobs.repair_order', resourceId: repairOrderId, cityId: job['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode,
        changeSummary: { feePaise: fee } }, meta);
      return { status: 200, body: { status: 'CANCELLED', feePaise: fee, billId } };
    }));
    return r.body;
  }

  /**
   * POST …/materials-confirmed (04 §10, 06 §8): before departure the technician confirms carrying every quoted material.
   * All present: the order is materials-confirmed (departure allowed). Any missing: ops is alerted (needs attention).
   */
  async confirmMaterials(actor: Actor, visitId: string, input: { items: readonly { quoteItemId: string; have: boolean }[] }, idempotencyKey: string, meta: RequestMeta) {
    return this.#technicianCommand(actor, visitId, 'POST /v1/technician/visits/:visitId/materials-confirmed', input, idempotencyKey, meta, async (c, visit) => {
      if (!(visit['purposes'] as string[]).includes('REPAIR') || !['ASSIGNED', 'EN_ROUTE'].includes(visit['status'] as string)) throw new AppError('INVALID_STATE');
      const ro = (await c.query(SQL.lockRepairOrder, [visit['repair_order_id']])).rows[0] as Row;
      const quoted = (ro['materials_required'] as QuotedMaterial[]).map((m) => m.quoteItemId).sort();
      const reported = input.items.map((i) => i.quoteItemId).sort();
      if (quoted.length !== reported.length || quoted.some((q, i) => q !== reported[i])) {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'items', code: 'MUST_LIST_EVERY_QUOTED_MATERIAL' }] });
      }
      const allPresent = input.items.every((i) => i.have);
      const now = this.#now();
      if (allPresent) await c.query(SQL.setMaterialsConfirmed, [ro['id'], now]);
      else await c.query(SQL.setJobAttention, [ro['job_id'], now]);
      await this.#event(c, allPresent ? 'MaterialsConfirmed' : 'MaterialsUnavailable', 'RepairOrder', ro['id'] as string, (ro['version'] as number) + 1,
        visit['city_id'] as string, { repairOrderId: ro['id'] as string, visitId, missing: input.items.filter((i) => !i.have).length }, meta);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'repair_order.materials_confirmed',
        resourceType: 'jobs.repair_order', resourceId: ro['id'] as string, cityId: visit['city_id'] as string, outcome: allPresent ? 'SUCCESS' : 'FAILED',
        changeSummary: { allPresent } }, meta);
      return { status: 200, body: { materialsConfirmed: allPresent } };
    });
  }

  /** Departure / arrival of a repair visit drive the order and the job (06 §2, §8); materials must be confirmed first. */
  async #repairVisitMoves(c: pg.ClientBase, visit: Row, step: 'DEPART' | 'START'): Promise<void> {
    if (!(visit['purposes'] as string[]).includes('REPAIR') || !visit['repair_order_id']) return;
    const ro = (await c.query(SQL.lockRepairOrder, [visit['repair_order_id']])).rows[0] as Row;
    const now = this.#now();
    if (step === 'DEPART') {
      const needsMaterials = (ro['materials_required'] as unknown[]).length > 0 && ro['materials_supplied_by'] === 'TECHNICIAN';
      if (needsMaterials && ro['materials_confirmed_at'] === null && ro['status'] === 'SCHEDULED') {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materials', code: 'NOT_CONFIRMED' }] });
      }
      const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
      if (job['status'] === 'REPAIR_PENDING') await c.query(SQL.setJobStatus, [visit['job_id'], 'REPAIR_IN_PROGRESS', now]);
      return;
    }
    if (ro['status'] === 'SCHEDULED') await c.query(SQL.setRepairOrderStatus, [ro['id'], 'IN_PROGRESS', now]);
  }

  // ---------------------------------------------------------------- Gate 6: repair completion (06 §3, INV-15, TCP-2, TCP-3)

  /** The customer's completion code (06 §3): shown only to the customer, re-issuable; a locked code stays locked. */
  async issueCompletionCode(actor: Actor, visitId: string, meta: RequestMeta): Promise<{ completionCode: string }> {
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    this.#require(actor, 'jobs.visit.completion_code', { ownerUserId: (v?.['customer_user_id'] as string | undefined) ?? null });
    return withTransaction(this.#d.pool, async (c) => {
      const locked = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      if (!(locked['purposes'] as string[]).includes('REPAIR') || isTerminal('visit', locked['status'] as string)) throw new AppError('INVALID_STATE');
      if ((locked['completion_code_attempts'] as number) >= this.#d.policy.codeMaxAttempts) throw new AppError('CODE_LOCKED');
      const code = numericCode(4);
      await c.query(SQL.setCompletionCode, [visitId, this.#codeHash(visitId, 'completion', code), this.#now()]);
      await this.#audit(c, { actorType: 'CUSTOMER', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.completion_code_issued',
        resourceType: 'jobs.visit', resourceId: visitId, outcome: 'SUCCESS' }, meta);
      return { completionCode: code };
    });
  }

  /**
   * Everything a completion needs that lives outside jobs, read BEFORE the transaction (B4): the approved version's facts
   * (diagnosis port), the usage checked against the quoted materials, and - for a complete repair - the bill snapshot
   * (approved total − unused material + waiting fees, INV-09), written by pricing in its own transaction.
   */
  async #prepareCompletion(visit: Row, input: CompletionInput): Promise<PreparedCompletion> {
    if (!(visit['purposes'] as string[]).includes('REPAIR') || !visit['repair_order_id']) throw new AppError('INVALID_STATE');
    const ro = (await this.#d.pool.query(SQL.repairOrder, [visit['repair_order_id']])).rows[0] as Row;
    if (ro['status'] === 'CHANGE_PENDING') throw new AppError('CHANGE_PENDING');
    if (ro['status'] !== 'IN_PROGRESS') throw new AppError('INVALID_STATE');
    const facts = await this.#d.repairQuotes.versionFacts(ro['quote_version_id'] as string);
    if (!facts || facts.status !== 'APPROVED') throw new AppError('CHANGE_PENDING');
    const lines: { quoteItemId: string; qtyUsed: number; actualUnitCostPaise: number | null }[] = [];
    let unusedCredit = 0;
    if (input.outcome === 'PARTIAL') {
      if (!input.partialReasonCode) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'partialReasonCode', code: 'REQUIRED' }] });
      if (input.materialUsage.length > 0) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage', code: 'REPORTED_AT_COMPLETION' }] });
    } else {
      const byItem = new Map(input.materialUsage.map((u) => [u.quoteItemId, u]));
      if (byItem.size !== input.materialUsage.length || byItem.size !== facts.materials.length) {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage', code: 'MUST_LIST_EVERY_QUOTED_MATERIAL' }] });
      }
      for (const m of facts.materials) {
        const u = byItem.get(m.quoteItemId);
        if (!u) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage', code: 'MUST_LIST_EVERY_QUOTED_MATERIAL' }] });
        let usedMilli: number;
        try {
          usedMilli = toMilli(u.qtyUsed);
        } catch {
          throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage.qtyUsed', code: 'INVALID' }] });
        }
        // More material than quoted needs a new quote version (03 §11 CHECK qty_used <= qty_quoted).
        if (usedMilli > m.qtyMilli) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage.qtyUsed', code: 'ABOVE_QUOTED' }] });
        unusedCredit += lineAmount(m.qtyMilli, m.unitPricePaise) - lineAmount(usedMilli, m.unitPricePaise);
        lines.push({ quoteItemId: m.quoteItemId, qtyUsed: u.qtyUsed, actualUnitCostPaise: u.actualUnitCostPaise ?? null });
      }
    }
    let snapshotId: string | null = null;
    let amountDue = 0;
    if (input.outcome === 'COMPLETE') {
      const fees = Number(((await this.#d.pool.query(SQL.waitFeesOfRepairOrder, [ro['id']])).rows[0] as Row)['fees']);
      amountDue = Math.max(0, facts.totalPayablePaise - unusedCredit + fees);
      snapshotId = await this.#d.pricing.snapshot({ rateCardId: facts.rateCardId, ruleRefs: { billKind: 'REPAIR_COMPLETION', quoteVersionId: facts.quoteVersionId },
        inputs: { repairOrderId: ro['id'] as string, visitId: visit['id'] as string, usage: lines },
        outputs: { amountDuePaise: amountDue, approvedTotalPaise: facts.totalPayablePaise, unusedMaterialCreditPaise: unusedCredit, waitingFeesPaise: fees } });
    }
    return { ro, facts, lines, snapshotId, amountDue };
  }

  /** The completion itself, inside the caller's transaction, after the code (or the approved override) was proven. */
  async #completeRepairInTx(c: pg.ClientBase, visit: Row, prepared: PreparedCompletion, input: CompletionInput,
    who: HistoryActor, meta: RequestMeta | null): Promise<CompletionBody> {
    const visitId = visit['id'] as string;
    const ro = (await c.query(SQL.lockRepairOrder, [visit['repair_order_id']])).rows[0] as Row;
    if (ro['status'] === 'CHANGE_PENDING') throw new AppError('CHANGE_PENDING');
    if (ro['status'] !== 'IN_PROGRESS' || ro['quote_version_id'] !== prepared.facts.quoteVersionId) throw new AppError('INVALID_STATE');
    const now = this.#now();
    await this.#context(c, who, meta, input.outcome === 'PARTIAL' ? (input.partialReasonCode ?? 'PARTIAL_WORK') : null);
    // TCP-2: usage recorded in this transaction; diagnosis re-checks the approved version under its own lock (INV-04).
    new UnitOfWork('jobs', TCPS).join('jobs', 'diagnosis', 'recordMaterialUsage');
    await this.#d.materialUsage.recordMaterialUsage(await this.#transactionContext(c), { repairOrderId: ro['id'] as string, visitId,
      quoteVersionId: prepared.facts.quoteVersionId, recordedBy: { actorType: who.type === 'ADMIN' ? 'ADMIN' : 'TECHNICIAN', actorId: who.id ?? '' },
      lines: prepared.lines });
    const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
    if (active) await c.query(SQL.endAssignment, [active['id'], 'COMPLETED', 'VISIT_COMPLETED', who.type, now]);
    await c.query(SQL.setVisitCompleted, [visitId, now, input.outcome === 'PARTIAL' ? 'PARTIAL_WORK' : 'COMPLETED',
      new Date(now.getTime() + this.#d.policy.disclosureCloseAfterMs)]);
    await this.#cancelTimers(c, visitId);
    const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
    let billId: string | null = null;
    if (input.outcome === 'COMPLETE') {
      await c.query(SQL.setRepairOrderCompleted, [ro['id'], now]);
      if (job['status'] === 'REPAIR_IN_PROGRESS') await c.query(SQL.setJobStatus, [job['id'], 'AWAITING_PAYMENT', now]);
      billId = await this.#issueBill(c, job['id'] as string, visitId, 'REPAIR_COMPLETION', prepared.snapshotId as string);
    } else {
      // D6: a partial repair blocks the order until the material / work is sorted; a new repair visit follows.
      await c.query(SQL.setRepairOrderBlocked, [ro['id'], input.partialReasonCode, now]);
      if (job['status'] === 'REPAIR_IN_PROGRESS') await c.query(SQL.setJobStatus, [job['id'], 'REPAIR_PENDING', now]);
      await this.#scheduleRepairTimer(c, ro['id'] as string, 'blockedFollowup', new Date(now.getTime() + this.#d.policy.blockedFollowupMs));
    }
    await this.#event(c, 'VisitCompleted', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string,
      { visitId, purposes: (visit['purposes'] as string[]).join(','), outcome: input.outcome, billId }, meta);
    await this.#event(c, input.outcome === 'COMPLETE' ? 'RepairOrderCompleted' : 'RepairOrderBlocked', 'RepairOrder', ro['id'] as string,
      (ro['version'] as number) + 1, visit['city_id'] as string, { repairOrderId: ro['id'] as string, visitId, billId, amountDuePaise: prepared.amountDue }, meta);
    return { visitStatus: 'COMPLETED', repairOrderStatus: input.outcome === 'COMPLETE' ? 'COMPLETED' : 'BLOCKED', billId,
      amountDuePaise: input.outcome === 'COMPLETE' ? prepared.amountDue : null };
  }

  /**
   * POST …/complete with the customer's completion code (INV-15, 04 §10). A wrong code is counted and committed (5
   * attempts, then it locks and ops is alerted). Refused while a change order is pending (409 CHANGE_PENDING).
   */
  async completeRepairVisit(actor: Actor, visitId: string, input: CompletionInput & { completionCode: string }, idempotencyKey: string, meta: RequestMeta) {
    const v0 = (await this.#assigneeVisit(actor, visitId, 'jobs.visit.act')).visit;
    const prepared = await this.#prepareCompletion(v0, input);
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const idem = { actorKey: `user:${actor.id ?? ''}`, idemKey: idempotencyKey, endpoint: 'POST /v1/technician/visits/:visitId/complete',
        requestHash: sha256(canonical({ visitId, input })), now: this.#now(), ttlMs: TECH_IDEMPOTENCY_TTL_MS };
      let start;
      try {
        start = await beginIdempotent(c, idem);
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          throw error.reason === 'KEY_REUSED' ? new AppError('IDEMPOTENCY_KEY_REUSED') : new AppError('REQUEST_IN_PROGRESS', { retryAfterSec: 1 });
        }
        throw error;
      }
      if (start.kind === 'REPLAY') return { replay: start };
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row;
      const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
      if (active?.['technician_user_id'] !== actor.id) throw new AppError('NOT_FOUND');
      if (visit['status'] !== 'IN_PROGRESS') throw new AppError('INVALID_STATE');
      const ro = (await c.query(SQL.lockRepairOrder, [visit['repair_order_id']])).rows[0] as Row | undefined;
      if (ro?.['status'] === 'CHANGE_PENDING') throw new AppError('CHANGE_PENDING');
      const max = this.#d.policy.codeMaxAttempts;
      const fail = async (code: 'CODE_INCORRECT' | 'CODE_LOCKED', details: Record<string, number>) => {
        await completeIdempotent(c, idem, code === 'CODE_LOCKED' ? 423 : 400, { code, details });
        return { error: new AppError(code, { details }) };
      };
      if ((visit['completion_code_attempts'] as number) >= max) return fail('CODE_LOCKED', { attemptsLeft: 0 });
      if (!constantTimeEqual(this.#codeHash(visitId, 'completion', input.completionCode), visit['completion_code_hash'] as Buffer)) {
        const attempts = ((await c.query(SQL.bumpCompletionCodeAttempts, [visitId, this.#now()])).rows[0] as Row)['completion_code_attempts'] as number;
        if (attempts >= max) {
          await c.query(SQL.setJobAttention, [visit['job_id'], this.#now()]);
          this.#d.logger.log('warn', 'jobs.completion_code_locked', { attemptCount: attempts });
          await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.completion_code_locked',
            resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'DENIED' }, meta);
          return fail('CODE_LOCKED', { attemptsLeft: 0 });
        }
        return fail('CODE_INCORRECT', { attemptsLeft: max - attempts });
      }
      await c.query(SQL.presenceProof, [newId(), visitId, 'COMPLETION_CODE', 'APP', 'TECHNICIAN', actor.id ?? null, null, null, this.#now()]);
      const body = await this.#completeRepairInTx(c, visit, prepared, input, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' }, meta);
      await completeIdempotent(c, idem, 200, body);
      await this.#audit(c, { actorType: 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'visit.completed',
        resourceType: 'jobs.visit', resourceId: visitId, cityId: visit['city_id'] as string, outcome: 'SUCCESS',
        changeSummary: { outcome: input.outcome, repairOrderStatus: body.repairOrderStatus } }, meta);
      return { ok: body };
    });
    if ('error' in outcome) throw outcome.error;
    if ('replay' in outcome) {
      const b = outcome.replay.body as { code?: string; details?: Record<string, number> };
      if (outcome.replay.status >= 400) throw new AppError((b.code ?? 'INTERNAL') as never, b.details ? { details: b.details } : {});
      return outcome.replay.body as CompletionBody;
    }
    return outcome.ok;
  }

  /** Validates an ops completion-override proposal (repair visit in progress); returns its city for the change-request scope. */
  async completionOverrideTarget(visitId: string): Promise<{ cityId: string } | null> {
    const v = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined) : undefined;
    if (!v || v['status'] !== 'IN_PROGRESS' || !(v['purposes'] as string[]).includes('REPAIR')) return null;
    return { cityId: v['city_id'] as string };
  }

  /**
   * Executes an approved ops completion override (INV-15 audited override, 06 §3: customer confirmed on a call to the
   * registered number, maker-checker): an OPS_OVERRIDE_COMPLETION proof referencing the change request, then the same
   * completion as with the code (TCP-2 usage, TCP-3 bill). Idempotent.
   */
  async executeCompletionOverride(changeRequestId: string, input: { visitId: string; reasonCode: string } & CompletionInput,
    ctx: { actorId: string; requestId: string }): Promise<void> {
    const v0 = (await this.#d.pool.query(SQL.visit, [input.visitId])).rows[0] as Row | undefined;
    if (!v0) throw new AppError('INVALID_STATE');
    if (v0['status'] === 'COMPLETED') return;
    const prepared = await this.#prepareCompletion(v0, input);
    await withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [input.visitId])).rows[0] as Row;
      if (visit['status'] === 'COMPLETED') return;
      if (visit['status'] !== 'IN_PROGRESS') throw new AppError('INVALID_STATE');
      const meta = { requestId: ctx.requestId, clientIp: '0.0.0.0' };
      await c.query(SQL.presenceProof, [newId(), input.visitId, 'OPS_OVERRIDE_COMPLETION', 'OPS', 'ADMIN', ctx.actorId, changeRequestId, input.reasonCode, this.#now()]);
      await this.#completeRepairInTx(c, visit, prepared, input, { type: 'ADMIN', id: ctx.actorId, channel: 'OPS' }, meta);
      await this.#audit(c, { actorType: 'ADMIN', actorId: ctx.actorId, action: 'visit.completion_overridden', resourceType: 'jobs.visit', resourceId: input.visitId,
        cityId: visit['city_id'] as string, outcome: 'SUCCESS', reasonCode: input.reasonCode, changeSummary: { changeRequestId, outcome: input.outcome } }, null);
    });
  }

  // ---------------------------------------------------------------- Gate 6: repair-order timers (06 §8)

  async #scheduleRepairTimer(c: pg.ClientBase, repairOrderId: string, task: 'repairUnscheduled' | 'blockedFollowup', at: Date): Promise<void> {
    await scheduleTimer(c, { task: TIMER_TASKS[task], key: `repair_order:${repairOrderId}:${task}`, runAt: at, payload: { repairOrderId } });
  }

  async #cancelRepairTimers(c: pg.ClientBase, repairOrderId: string): Promise<void> {
    for (const t of ['repairUnscheduled', 'blockedFollowup'] as const) await cancelTimer(c, `repair_order:${repairOrderId}:${t}`);
  }

  /** Still AWAITING_SCHEDULE (24 h) or BLOCKED (48 h) when the timer fires → ops queue (needs attention); no state change. */
  async onRepairOrderFollowup(repairOrderId: string, expected: 'AWAITING_SCHEDULE' | 'BLOCKED'): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const ro = (await c.query(SQL.lockRepairOrder, [repairOrderId])).rows[0] as Row | undefined;
      if (!ro || ro['status'] !== expected) return false;
      await c.query(SQL.setJobAttention, [ro['job_id'], this.#now()]);
      const job = (await c.query(SQL.job, [ro['job_id']])).rows[0] as Row;
      await this.#event(c, expected === 'BLOCKED' ? 'RepairOrderBlockedFollowup' : 'RepairOrderUnscheduled', 'RepairOrder', repairOrderId,
        ro['version'] as number, job['city_id'] as string, { repairOrderId }, null);
      return true;
    });
  }

  // ---------------------------------------------------------------- timers (ADR-015, 06 §3) and the sweeper

  /** PLANNED → MATCHING at the match-start time. */
  async onMatchStart(visitId: string): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      if (!visit || visit['status'] !== 'PLANNED') return false;
      const now = this.#now();
      const due = matchStartAt({ start: visit['window_start'] as Date }, visit['urgency'] as 'ASAP' | 'SCHEDULED', new Date(0), this.#d.policy);
      if (due.getTime() > now.getTime()) {
        await this.#schedule(c, visitId, 'matchStart', due);
        return false;
      }
      await this.#context(c, SYSTEM, null, 'MATCH_START');
      await c.query(SQL.setVisitMatching, [visitId, now]);
      await this.#schedule(c, visitId, 'matchSla', new Date(now.getTime() + this.#slaMs(visit)));
      await this.#event(c, 'VisitReadyForMatching', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string, { visitId }, null);
      return true;
    });
  }

  /** MATCHING past its SLA → UNFULFILLED, job needs attention. */
  async onMatchSla(visitId: string): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      if (!visit || visit['status'] !== 'MATCHING') return false;
      const since = visit['matching_since'] as Date | null;
      const now = this.#now();
      const due = new Date((since ?? now).getTime() + this.#slaMs(visit));
      if (due.getTime() > now.getTime()) {
        await this.#schedule(c, visitId, 'matchSla', due);
        return false;
      }
      await this.#context(c, SYSTEM, null, 'MATCH_SLA_EXCEEDED');
      await c.query(SQL.setVisitStatus, [visitId, 'UNFULFILLED', now]);
      await c.query(SQL.setJobAttention, [visit['job_id'], now]);
      await this.#event(c, 'VisitUnfulfilled', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string, { visitId }, null);
      return true;
    });
  }

  /** Technician not arrived by window start + grace (and not waiting at the door) → assignment NO_SHOW, visit re-matched. */
  async onTechNoShow(visitId: string): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      if (!visit || (visit['status'] !== 'ASSIGNED' && visit['status'] !== 'EN_ROUTE') || visit['arrived_at'] !== null) return false;
      if ((await c.query(SQL.openWait, [visitId])).rows.length > 0) return false;
      const now = this.#now();
      const due = new Date((visit['window_start'] as Date).getTime() + this.#d.policy.techNoShowGraceMs);
      if (due.getTime() > now.getTime()) {
        await this.#schedule(c, visitId, 'techNoShow', due);
        return false;
      }
      await this.#context(c, SYSTEM, null, 'TECH_NO_SHOW');
      await this.#backToMatching(c, visit, { assignmentStatus: 'NO_SHOW', reason: 'TECH_NO_SHOW', by: 'SYSTEM' }, null);
      await c.query(SQL.setJobAttention, [visit['job_id'], now]);
      return true;
    });
  }

  /** Wait past its grace with the visit still EN_ROUTE → CUSTOMER_NO_SHOW: no-show fee billed (TCP-3), technician compensated. */
  async onCustomerNoShow(visitId: string): Promise<boolean> {
    const v = (await this.#d.pool.query(SQL.visit, [visitId])).rows[0] as Row | undefined;
    if (!v || v['status'] !== 'EN_ROUTE') return false;
    const rules = await this.#d.pricing.lifecycleFeeRules(v['city_id'] as string, this.#now());
    if (!rules) {
      this.#d.logger.log('warn', 'jobs.no_show_without_fee_rules', { outcome: 'DEFERRED' });
      return false;
    }
    const fee = noShowFee(rules);
    const snapshotId = await this.#d.pricing.snapshot({ rateCardId: rules.rateCardId, ruleRefs: { feeType: 'NO_SHOW' }, inputs: { visitId },
      outputs: { customerFeePaise: fee.customerFeePaise, technicianCompensationPaise: fee.technicianCompensationPaise } });
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      const wait = (await c.query(SQL.openWait, [visitId])).rows[0] as Row | undefined;
      if (!visit || visit['status'] !== 'EN_ROUTE' || !wait) return false;
      const now = this.#now();
      const due = new Date((wait['started_at'] as Date).getTime() + this.#d.policy.waitGraceMs);
      if (due.getTime() > now.getTime()) {
        await this.#schedule(c, visitId, 'customerNoShow', due);
        return false;
      }
      await this.#context(c, SYSTEM, null, 'CUSTOMER_NO_SHOW');
      await c.query(SQL.endWait, [wait['id'], now, 'CUSTOMER_NO_SHOW', 0, 0]);
      const active = (await c.query(SQL.activeAssignment, [visitId])).rows[0] as Row | undefined;
      if (active) await c.query(SQL.endAssignment, [active['id'], 'COMPLETED', 'CUSTOMER_NO_SHOW', 'SYSTEM', now]);
      await c.query(SQL.setVisitTerminal, [visitId, 'CUSTOMER_NO_SHOW', 'CUSTOMER_NO_SHOW', new Date(now.getTime() + this.#d.policy.disclosureCloseAfterMs), now]);
      const job = (await c.query(SQL.lockJob, [visit['job_id']])).rows[0] as Row;
      if (job['status'] === 'IN_DIAGNOSIS') await c.query(SQL.setJobStatus, [visit['job_id'], 'AWAITING_PAYMENT', now]);
      await this.#cancelTimers(c, visitId);
      const billId = await this.#issueBill(c, visit['job_id'] as string, visitId, 'NO_SHOW_FEE', snapshotId);
      await this.#event(c, 'VisitNoShow', 'Visit', visitId, (visit['version'] as number) + 1, visit['city_id'] as string,
        { visitId, billId, feePaise: fee.customerFeePaise }, null);
      return true;
    });
  }

  /** IN_PROGRESS longer than the maximum visit time → ops check-in (needs_attention); no state change. */
  async onOverrun(visitId: string): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const visit = (await c.query(SQL.lockVisit, [visitId])).rows[0] as Row | undefined;
      if (!visit || visit['status'] !== 'IN_PROGRESS' || visit['arrived_at'] === null) return false;
      const now = this.#now();
      if ((visit['arrived_at'] as Date).getTime() + this.#d.policy.maxVisitMs > now.getTime()) return false;
      await c.query(SQL.setJobAttention, [visit['job_id'], now]);
      await this.#event(c, 'VisitOverrun', 'Visit', visitId, visit['version'] as number, visit['city_id'] as string, { visitId }, null);
      return true;
    });
  }

  /** The 1-minute sweeper (ADR-015): re-applies every overdue transition whose timer was lost or delayed. Idempotent. */
  async sweep(limit = 100): Promise<Record<string, number>> {
    const now = this.#now();
    const p = this.#d.policy;
    const ids = async (sql: string, params: unknown[]) => ((await this.#d.pool.query(sql, params)).rows as Row[]).map((r) => r['id'] as string);
    const run = async (list: string[], fn: (id: string) => Promise<boolean>) => {
      let n = 0;
      for (const id of list) if (await fn(id)) n += 1;
      return n;
    };
    return {
      matchStart: await run(await ids(SQL.overduePlanned, [now, p.matchLeadMs, limit]), (id) => this.onMatchStart(id)),
      matchSla: await run(await ids(SQL.overdueMatching, [now, p.asapMatchSlaMs, p.scheduledMatchSlaMs, limit]), (id) => this.onMatchSla(id)),
      techNoShow: await run(await ids(SQL.overdueNoShow, [now, p.techNoShowGraceMs, limit]), (id) => this.onTechNoShow(id)),
      customerNoShow: await run(await ids(SQL.overdueWaits, [now, p.waitGraceMs, limit]), (id) => this.onCustomerNoShow(id)),
      overrun: await run(await ids(SQL.overdueOverrun, [now, p.maxVisitMs, limit]), (id) => this.onOverrun(id)),
    };
  }

  /** Timer task handlers for the worker (payload `{ visitId }`), plus the sweeper. */
  timerTasks(): Record<string, (payload: unknown) => Promise<void>> {
    const visitIdOf = (p: unknown) => {
      const id = (p as { visitId?: unknown } | null)?.visitId;
      return typeof id === 'string' && UUID.test(id) ? id : null;
    };
    const handler = (fn: (id: string) => Promise<boolean>) => async (p: unknown) => {
      const id = visitIdOf(p);
      if (id) await fn(id);
    };
    const repairOrderHandler = (expected: 'AWAITING_SCHEDULE' | 'BLOCKED') => async (p: unknown) => {
      const id = (p as { repairOrderId?: unknown } | null)?.repairOrderId;
      if (typeof id === 'string' && UUID.test(id)) await this.onRepairOrderFollowup(id, expected);
    };
    return {
      [TIMER_TASKS.autoCheckout]: handler((id) => this.onAutoCheckout(id)),
      [TIMER_TASKS.repairUnscheduled]: repairOrderHandler('AWAITING_SCHEDULE'),
      [TIMER_TASKS.blockedFollowup]: repairOrderHandler('BLOCKED'),
      [TIMER_TASKS.matchStart]: handler((id) => this.onMatchStart(id)),
      [TIMER_TASKS.matchSla]: handler((id) => this.onMatchSla(id)),
      [TIMER_TASKS.techNoShow]: handler((id) => this.onTechNoShow(id)),
      [TIMER_TASKS.customerNoShow]: handler((id) => this.onCustomerNoShow(id)),
      [TIMER_TASKS.overrun]: handler((id) => this.onOverrun(id)),
      [TIMER_TASKS.sweep]: async () => {
        await this.sweep();
      },
    };
  }
}

function assertOrInvalid(machine: 'visit', from: string, to: string): void {
  try {
    assertTransition(machine, from, to);
  } catch {
    throw new AppError('INVALID_STATE');
  }
}
