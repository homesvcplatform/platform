// diagnosis application service (Phase 1 06 §6–§7, 04 §10–§11, 02 §4, SR-05, INV-04..08, INV-21; Gate 6, ADR-027).
// Diagnoses are drafted and submitted by the visit's ACTIVE technician (or captured by ops on a bridged call, local / test
// only until telephony); submission prices the quote on the server (pricing engine, immutable snapshot written by
// pricing before this module's transaction, B4), freezes the version with its content hash and presents it. Customers
// decide on their own channel (session, or signed link + OTP to the registered number); the ops-recorded channel exists
// but is off (D-11). Every command runs in one transaction: lock, state checks, actor context (history), outbox, audit.
// Repair orders follow asynchronously in jobs (QuoteApproved, 01 §5).
import type pg from 'pg';
import {
  appendAudit, beginIdempotent, cancelTimer, completeIdempotent, IdempotencyConflict, scheduleTimer, withTransaction, type AuditEntry,
} from '@hsp/db';
import { AppError } from '@hsp/errors';
import { newId, type AppEnvironment, type Clock } from '@hsp/kernel';
import { milliToString, toMilli } from '@hsp/money';
import type { ApprovedQuoteFacts, DiagnosisVisitFacts, MaterialUsageRecorder, QuoteJobFacts, RepairQuotes, TransactionContext } from '@hsp/module-jobs';
import type { PricedLine, PricedQuote, QuoteLineInput, QuotePriceResult } from '@hsp/module-pricing';
import type { Logger } from '@hsp/observability';
import { recentStepUp, type Actor, type PolicyRegistry } from '@hsp/policy';
import { hmacSha256, sha256 } from '@hsp/security';
import {
  canonicalJson, isLinkPreviewAgent, linkTokenHash, newLinkToken, quoteContentHash, repairOptions, type DiagnosisPolicy, type HashedLine, type RepairOption,
} from '../domain/rules.ts';
import { SQL } from '../infrastructure/sql.ts';
import type { CallEvidence, CatalogReads, CustomerOtp, JobsReads, QuoteLinkSender, QuotePricing, TechnicianSkills } from '../public/ports.ts';

export interface DiagnosisDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policies: PolicyRegistry;
  readonly policy: DiagnosisPolicy;
  /** HMAC key for the audit IP hash. */
  readonly requestHashKey: Buffer;
  readonly appEnv: AppEnvironment;
  readonly jobs: JobsReads;
  readonly catalog: CatalogReads;
  readonly pricing: QuotePricing;
  readonly skills: TechnicianSkills;
  readonly otp: CustomerOtp;
  readonly links: QuoteLinkSender;
  readonly callEvidence: CallEvidence;
}

export interface RequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
}

export type DraftLine =
  | { readonly type: 'REPAIR_ITEM'; readonly repairItemId: string; readonly qty: number }
  | { readonly type: 'MATERIAL'; readonly materialId: string; readonly qty: number; readonly proposedUnitPricePaise?: number | undefined; readonly reasonCode?: string | undefined }
  | { readonly type: 'CUSTOM_LABOUR'; readonly qty: number; readonly proposedUnitPricePaise: number; readonly reasonCode: string };

export interface DraftContent {
  readonly expectedVersion: number;
  readonly problemCode: string;
  readonly observedChips: readonly string[];
  readonly severity: 'MINOR' | 'MODERATE' | 'MAJOR' | 'SAFETY_HAZARD';
  readonly safetyAdviceCode: string | null;
  readonly items: readonly DraftLine[];
  readonly noRepairNeeded: boolean;
  readonly sameVisitFeasible: boolean;
  readonly materialAvailableNow: boolean;
}

export interface DecisionInput {
  readonly contentHash: string;
  readonly repairPreference?: RepairOption | undefined;
  readonly allowFallback?: boolean | undefined;
  readonly preferredWindow?: { readonly start: string; readonly end: string } | undefined;
  readonly reasonCode?: string | undefined;
}

export interface SubmitResult {
  readonly diagnosisId: string;
  readonly quoteVersionId: string | null;
  readonly versionNo: number | null;
  readonly totalPayablePaise: number | null;
  readonly sameVisitOptionOffered: boolean;
}

export const DIAGNOSIS_TIMER_TASKS = {
  quoteExpire: 'diagnosis.quote.expire',
  sweep: 'diagnosis.sweep',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TECH_IDEMPOTENCY_TTL_MS = 7 * 24 * 3_600_000; // X-20: offline replays

type Row = Record<string, unknown>;
type Who = { readonly type: 'CUSTOMER' | 'TECHNICIAN' | 'ADMIN' | 'SYSTEM'; readonly id: string | null; readonly channel: string };
type Capture = { readonly kind: 'TECHNICIAN'; readonly actorId: string } | { readonly kind: 'OPS_AGENT'; readonly actorId: string; readonly bridgedCall: string };
const SYSTEM: Who = { type: 'SYSTEM', id: null, channel: 'SYSTEM' };

interface Evidence {
  readonly channel: 'APP_SESSION' | 'SIGNED_LINK_OTP' | 'OPS_RECORDED_CALL';
  readonly customerUserId: string;
  readonly sessionId?: string | null;
  readonly otpChallengeId?: string | null;
  readonly callSessionId?: string | null;
  readonly recorderAdminId?: string | null;
  readonly verifierAdminId?: string | null;
  readonly capturerAdminId?: string | null;
  /** SIGNED_LINK_OTP: the link used (single successful decision, SR-05). */
  readonly linkId?: string | null;
}

const num = (v: unknown) => Number(v);
const expiryKey = (versionId: string) => `quote_version:${versionId}:expire`;

/** Display / hash form of a priced line (qty as the stored numeric(10,3) text). */
function hashedLine(l: PricedLine): HashedLine {
  return { lineNo: l.lineNo, itemType: l.itemType, repairItemId: l.repairItemId, materialId: l.materialId, labelKey: l.labelKey, labelParams: l.labelParams,
    qty: milliToString(l.qtyMilli), unitPricePaise: l.unitPricePaise, amountPaise: l.amountPaise };
}

function pricingFailure(r: Extract<QuotePriceResult, { ok: false }>, offset: number): AppError {
  const path = r.line === null ? 'items' : `items.${Math.max(0, r.line - offset)}`;
  switch (r.code) {
    case 'NO_RATE_CARD': return new AppError('INVALID_STATE');
    case 'CUSTOM_LABOUR_OUT_OF_BAND': return new AppError('CUSTOM_LABOUR_OUT_OF_BAND', { fields: [{ path, code: 'OUT_OF_BAND' }] });
    case 'MATERIAL_DEVIATION_NEEDS_REASON': return new AppError('VALIDATION_FAILED', { fields: [{ path: `${path}.reasonCode`, code: 'REQUIRED' }] });
    default: return new AppError('VALIDATION_FAILED', { fields: [{ path, code: r.code }] });
  }
}

export class DiagnosisService {
  readonly #d: DiagnosisDeps;

  constructor(deps: DiagnosisDeps) {
    this.#d = deps;
  }

  #now(): Date {
    return this.#d.clock.now();
  }

  #require(actor: Actor, action: string, resource: unknown): void {
    const d = this.#d.policies.can(actor, action, resource, { now: this.#now() });
    if (!d.allow) throw new AppError(d.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN');
  }

  async #context(c: pg.ClientBase, who: Who, meta: RequestMeta | null, reason: string | null = null): Promise<void> {
    const corr = meta && UUID.test(meta.requestId) ? meta.requestId : newId();
    await c.query(SQL.actorContext, [who.type, who.id ?? '', who.channel, corr, reason ?? '']);
  }

  async #audit(c: pg.ClientBase, entry: AuditEntry, meta: RequestMeta | null): Promise<void> {
    await appendAudit(c, { ...entry, requestId: meta?.requestId ?? null, ipHash: meta ? hmacSha256(this.#d.requestHashKey, `ip|${meta.clientIp}`) : null });
  }

  async #event(c: pg.ClientBase, type: string, aggregate: 'Diagnosis' | 'Quote', id: string, version: number, cityId: string | null,
    payload: Record<string, string | number | boolean | null>, meta: RequestMeta | null): Promise<void> {
    await c.query(SQL.outbox, [newId(), type, aggregate, id, version, JSON.stringify(payload),
      meta && UUID.test(meta.requestId) ? meta.requestId : newId(), cityId, this.#now()]);
  }

  /** Runs `fn` under an Idempotency-Key; a replay returns the stored response (an error response is re-thrown). */
  async #idempotent<T>(c: pg.ClientBase, req: { actorKey: string; key: string; endpoint: string; body: unknown; ttlMs?: number },
    fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
    const idem = { actorKey: req.actorKey, idemKey: req.key, endpoint: req.endpoint, requestHash: sha256(canonicalJson(req.body)), now: this.#now(),
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

  #opsCaptureAllowed(): void {
    // ADR-027 #3: ops-desk capture depends on bridged-call evidence (telephony, Gate 10): local / test only until then.
    if (this.#d.appEnv !== 'local' && this.#d.appEnv !== 'test') throw new AppError('FEATURE_DISABLED');
  }

  // ---------------------------------------------------------------- reads

  async #diagnosisRow(diagnosisId: string): Promise<Row | undefined> {
    return UUID.test(diagnosisId) ? ((await this.#d.pool.query(SQL.diagnosis, [diagnosisId])).rows[0] as Row | undefined) : undefined;
  }

  async #versionRow(versionId: string): Promise<Row | undefined> {
    return UUID.test(versionId) ? ((await this.#d.pool.query(SQL.version, [versionId])).rows[0] as Row | undefined) : undefined;
  }

  async #visitFeePaise(facts: { visitFeeSnapshotId: string }): Promise<number> {
    const fee = (await this.#d.pricing.snapshotOutputs(facts.visitFeeSnapshotId))?.['visitFeePaise'];
    if (typeof fee !== 'number') throw new AppError('INVALID_STATE');
    return fee;
  }

  // ---------------------------------------------------------------- authorization helpers

  /** The visit for a technician write: 404 unless the actor is its ACTIVE assignee (05 §4.2). */
  async #visitForTechnician(actor: Actor, visitId: string): Promise<DiagnosisVisitFacts> {
    const facts = UUID.test(visitId) ? await this.#d.jobs.diagnosisVisitFacts(visitId) : null;
    this.#require(actor, 'diagnosis.diagnosis.write', { isAssignee: facts !== null && actor.id !== undefined && facts.activeTechnicianUserId === actor.id });
    return facts as DiagnosisVisitFacts;
  }

  /** A diagnosis the technician may edit: their own, on a visit where they are the ACTIVE assignee. */
  async #ownDiagnosis(actor: Actor, diagnosisId: string): Promise<{ d: Row; facts: DiagnosisVisitFacts }> {
    const d = await this.#diagnosisRow(diagnosisId);
    const facts = d ? await this.#d.jobs.diagnosisVisitFacts(d['visit_id'] as string) : null;
    const ok = d !== undefined && facts !== null && actor.id !== undefined && facts.activeTechnicianUserId === actor.id
      && d['captured_by_actor_type'] === 'TECHNICIAN' && d['technician_user_id'] === actor.id;
    this.#require(actor, 'diagnosis.diagnosis.write', { isAssignee: ok });
    return { d: d as Row, facts: facts as DiagnosisVisitFacts };
  }

  /** A diagnosis ops captured: only its capturer edits it, with the capture permission for the city. */
  async #opsDiagnosis(actor: Actor, diagnosisId: string): Promise<{ d: Row; facts: DiagnosisVisitFacts }> {
    this.#opsCaptureAllowed();
    this.#require(actor, 'diagnosis.ops_capture', { cityId: undefined });
    const d = await this.#diagnosisRow(diagnosisId);
    const facts = d ? await this.#d.jobs.diagnosisVisitFacts(d['visit_id'] as string) : null;
    if (!d || !facts || d['captured_by_actor_type'] !== 'OPS_AGENT' || d['captured_by_actor_id'] !== actor.id) throw new AppError('NOT_FOUND');
    this.#require(actor, 'diagnosis.ops_capture', { cityId: facts.cityId });
    return { d, facts };
  }

  // ---------------------------------------------------------------- diagnosis drafts (04 §10, 06 §6)

  /** POST /v1/technician/visits/{visitId}/diagnoses: create (or return the open) draft. */
  async startDiagnosis(actor: Actor, visitId: string, input: { kind: 'INITIAL' | 'ADDITIONAL_FINDING' }, idempotencyKey: string, meta: RequestMeta) {
    const facts = await this.#visitForTechnician(actor, visitId);
    return this.#start(facts, input.kind, { kind: 'TECHNICIAN', actorId: actor.id ?? '' }, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' },
      actor, idempotencyKey, meta, 'POST /v1/technician/visits/:visitId/diagnoses');
  }

  /** Ops-desk capture for a basic-phone technician on a bridged call (ADR-027 #3; local / test until Gate 10). */
  async opsStartDiagnosis(actor: Actor, visitId: string, input: { kind: 'INITIAL' | 'ADDITIONAL_FINDING'; callSessionId: string }, idempotencyKey: string,
    meta: RequestMeta) {
    this.#opsCaptureAllowed();
    this.#require(actor, 'diagnosis.ops_capture', { cityId: undefined });
    const facts = UUID.test(visitId) ? await this.#d.jobs.diagnosisVisitFacts(visitId) : null;
    if (!facts) throw new AppError('NOT_FOUND');
    this.#require(actor, 'diagnosis.ops_capture', { cityId: facts.cityId });
    if (!facts.activeTechnicianUserId) throw new AppError('INVALID_STATE');
    if (!(await this.#d.callEvidence.bridgedCall(input.callSessionId, { visitId, technicianUserId: facts.activeTechnicianUserId }))) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'callSessionId', code: 'NOT_A_BRIDGED_CALL' }] });
    }
    return this.#start(facts, input.kind, { kind: 'OPS_AGENT', actorId: actor.id ?? '', bridgedCall: input.callSessionId },
      { type: 'ADMIN', id: actor.id ?? null, channel: 'OPS' }, actor, idempotencyKey, meta, 'POST /admin/v1/visits/:visitId/diagnoses');
  }

  async #start(facts: DiagnosisVisitFacts, kind: 'INITIAL' | 'ADDITIONAL_FINDING', capture: Capture, who: Who, actor: Actor, idempotencyKey: string,
    meta: RequestMeta, endpoint: string) {
    if (facts.status !== 'IN_PROGRESS' || !facts.activeTechnicianUserId) throw new AppError('INVALID_STATE');
    if (kind === 'INITIAL' && (!facts.purposes.includes('DIAGNOSIS') || facts.purposes.includes('REPAIR'))) throw new AppError('INVALID_STATE');
    if (kind === 'ADDITIONAL_FINDING' && !facts.purposes.includes('REPAIR')) throw new AppError('INVALID_STATE');
    const technicianUserId = facts.activeTechnicianUserId;
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `${who.type === 'ADMIN' ? 'admin' : 'user'}:${actor.id ?? ''}`,
      key: idempotencyKey, endpoint, body: { visitId: facts.visitId, kind }, ttlMs: TECH_IDEMPOTENCY_TTL_MS }, async () => {
      const open = (await c.query(SQL.openDraft, [facts.visitId, kind])).rows[0] as Row | undefined;
      if (open) return { status: 200, body: { diagnosisId: open['id'] as string, version: num(open['version']) } };
      const id = newId();
      await c.query(SQL.insertDiagnosis, [id, facts.jobId, facts.visitId, technicianUserId, capture.kind, capture.actorId, kind, this.#now()]);
      await this.#audit(c, { actorType: who.type === 'ADMIN' ? 'ADMIN' : 'TECHNICIAN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null,
        action: 'diagnosis.draft_created', resourceType: 'diagnosis.diagnosis', resourceId: id, cityId: facts.cityId, outcome: 'SUCCESS',
        changeSummary: { kind, capturedBy: capture.kind, ...(capture.kind === 'OPS_AGENT' ? { bridgedCall: capture.bridgedCall } : {}) } }, meta);
      return { status: 201, body: { diagnosisId: id, version: 0 } };
    }));
    return r.body;
  }

  /** Validates draft content against the catalog (problem taxonomy, repair items of the job's service type, materials). */
  async #validated(facts: DiagnosisVisitFacts, kind: string, content: Omit<DraftContent, 'expectedVersion'>) {
    const bad = (path: string, code: string) => new AppError('VALIDATION_FAILED', { fields: [{ path, code }] });
    if (!(await this.#d.catalog.problemCodes(facts.serviceTypeId)).includes(content.problemCode)) throw bad('problemCode', 'UNKNOWN');
    if (content.severity === 'SAFETY_HAZARD' && !content.safetyAdviceCode) throw bad('safetyAdviceCode', 'REQUIRED');
    if (content.noRepairNeeded && (content.items.length > 0 || kind !== 'INITIAL')) throw bad('items', 'NOT_ALLOWED_WITHOUT_REPAIR');
    if (!content.noRepairNeeded && content.items.length === 0) throw bad('items', 'REQUIRED');
    const repairIds = content.items.flatMap((i) => (i.type === 'REPAIR_ITEM' ? [i.repairItemId] : []));
    const materialIds = content.items.flatMap((i) => (i.type === 'MATERIAL' ? [i.materialId] : []));
    const repairs = new Map((await this.#d.catalog.getRepairItemsByIds(repairIds)).map((r) => [r.id, r]));
    const materials = new Set((await this.#d.catalog.getMaterialsByIds(materialIds)).map((m) => m.id));
    for (const [i, line] of content.items.entries()) {
      if (line.type === 'REPAIR_ITEM' && repairs.get(line.repairItemId)?.serviceTypeId !== facts.serviceTypeId) throw bad(`items.${i}.repairItemId`, 'UNKNOWN');
      if (line.type === 'MATERIAL' && !materials.has(line.materialId)) throw bad(`items.${i}.materialId`, 'UNKNOWN');
      try {
        if (toMilli(line.qty) === 0) throw new Error('zero');
      } catch {
        throw bad(`items.${i}.qty`, 'INVALID');
      }
    }
    // The repair order carries one required skill (06 §8); a diagnosis naming two specialised skills is split into jobs.
    const types = new Set([...repairs.values()].map((r) => r.requiredServiceTypeId));
    const specs = new Set([...repairs.values()].map((r) => r.requiredSpecializationId).filter((s): s is string => s !== null));
    if (types.size > 1 || specs.size > 1) throw bad('items', 'MULTIPLE_REPAIR_SKILLS');
    const requiredType = content.noRepairNeeded ? null : ([...types][0] ?? facts.serviceTypeId);
    const requiredSpec = content.noRepairNeeded ? null : ([...specs][0] ?? null);
    return { requiredType, requiredSpec };
  }

  /** PUT /v1/technician/diagnoses/{id}: replaces the draft content (optimistic: `expectedVersion`). */
  async updateDraft(actor: Actor, diagnosisId: string, content: DraftContent, idempotencyKey: string, meta: RequestMeta) {
    const { d, facts } = await this.#ownDiagnosis(actor, diagnosisId);
    return this.#update(d, facts, content, actor, idempotencyKey, meta, 'PUT /v1/technician/diagnoses/:diagnosisId');
  }

  async opsUpdateDraft(actor: Actor, diagnosisId: string, content: DraftContent, idempotencyKey: string, meta: RequestMeta) {
    const { d, facts } = await this.#opsDiagnosis(actor, diagnosisId);
    return this.#update(d, facts, content, actor, idempotencyKey, meta, 'PUT /admin/v1/diagnoses/:diagnosisId');
  }

  async #update(d: Row, facts: DiagnosisVisitFacts, content: DraftContent, actor: Actor, idempotencyKey: string, meta: RequestMeta, endpoint: string) {
    if (d['status'] !== 'DRAFT') throw new AppError('INVALID_STATE');
    const { requiredType, requiredSpec } = await this.#validated(facts, d['kind'] as string, content);
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { actorKey: `${actor.kind === 'ADMIN' ? 'admin' : 'user'}:${actor.id ?? ''}`,
      key: idempotencyKey, endpoint, body: { diagnosisId: d['id'], content }, ttlMs: TECH_IDEMPOTENCY_TTL_MS }, async () => {
      const updated = (await c.query(SQL.updateDraft, [d['id'], content.expectedVersion, content.problemCode, content.observedChips, content.severity,
        content.safetyAdviceCode, content.noRepairNeeded, content.sameVisitFeasible, content.materialAvailableNow, JSON.stringify(content.items),
        requiredType, requiredSpec, this.#now()])).rows[0] as Row | undefined;
      if (!updated) throw new AppError('STALE_VERSION');
      return { status: 200, body: { diagnosisId: d['id'] as string, version: num(updated['version']) } };
    }));
    return r.body;
  }

  // ---------------------------------------------------------------- pricing (06 §7: only the server prices)

  /** The draft's lines (and, for a change order, the approved version's lines first) as pricing input. */
  async #priceRequest(facts: DiagnosisVisitFacts, d: Row, draft: readonly DraftLine[], approved: Row | null) {
    const carriedIds = approved ? (approved['diagnosis_ids'] as string[]) : [];
    const carried = carriedIds.length > 0 ? ((await this.#d.pool.query(SQL.diagnosisLines, [carriedIds])).rows as Row[]).map((r): DraftLine => {
      const qty = Number(r['qty']);
      if (r['line_type'] === 'REPAIR_ITEM') return { type: 'REPAIR_ITEM', repairItemId: r['repair_item_id'] as string, qty };
      if (r['line_type'] === 'MATERIAL') {
        return { type: 'MATERIAL', materialId: r['material_id'] as string, qty,
          ...(r['proposed_unit_price_paise'] !== null ? { proposedUnitPricePaise: num(r['proposed_unit_price_paise']) } : {}),
          ...(r['reason_code'] !== null ? { reasonCode: r['reason_code'] as string } : {}) };
      }
      return { type: 'CUSTOM_LABOUR', qty, proposedUnitPricePaise: num(r['proposed_unit_price_paise']), reasonCode: r['reason_code'] as string };
    }) : [];
    const all = [...carried, ...draft];
    const at = this.#now();
    const repairs = new Map((await this.#d.catalog.getRepairItemsByIds(all.flatMap((l) => (l.type === 'REPAIR_ITEM' ? [l.repairItemId] : []))))
      .map((r) => [r.id, r.code]));
    const materials = new Map((await this.#d.catalog.getMaterialsByIds(all.flatMap((l) => (l.type === 'MATERIAL' ? [l.materialId] : []))))
      .map((m) => [m.id, m.code]));
    const lines: QuoteLineInput[] = [];
    for (const l of all) {
      if (l.type === 'REPAIR_ITEM') lines.push({ type: 'REPAIR_ITEM', repairItemId: l.repairItemId, code: repairs.get(l.repairItemId) ?? 'UNKNOWN', qty: l.qty });
      else if (l.type === 'MATERIAL') {
        const ref = await this.#d.catalog.getMaterialReference(l.materialId, facts.cityId, at);
        lines.push({ type: 'MATERIAL', materialId: l.materialId, code: materials.get(l.materialId) ?? 'UNKNOWN', qty: l.qty,
          referenceUnitPaise: ref ? Number(ref.unitPricePaise) : null, proposedUnitPaise: l.proposedUnitPricePaise ?? null, reasonCode: l.reasonCode ?? null });
      } else lines.push({ type: 'CUSTOM_LABOUR', qty: l.qty, proposedUnitPaise: l.proposedUnitPricePaise, reasonCode: l.reasonCode });
    }
    const rateCardId = approved ? await this.#d.pricing.snapshotRateCardId(approved['price_snapshot_id'] as string) : null;
    return {
      offset: carried.length,
      request: { cityId: facts.cityId, at, ...(rateCardId ? { rateCardId } : {}), visitFeePaise: await this.#visitFeePaise(facts), lines,
        refs: { jobId: facts.jobId, diagnosisIds: [...carriedIds, d['id'] as string] } },
    };
  }

  async #price(facts: DiagnosisVisitFacts, d: Row, draft: readonly DraftLine[], approved: Row | null, persist: boolean) {
    const { request, offset } = await this.#priceRequest(facts, d, draft, approved);
    const r = await this.#d.pricing.priceQuote(request, { persist });
    if (!r.ok) throw pricingFailure(r, offset);
    const hash = quoteContentHash(r.quote.lines.map(hashedLine), r.quote.totals);
    return { priced: r.quote, rateCardId: r.rateCardId, snapshotId: r.snapshotId, hash };
  }

  #view(q: PricedQuote) {
    return {
      lines: q.lines.map((l) => ({ lineNo: l.lineNo, type: l.itemType, labelKey: l.labelKey, labelParams: l.labelParams, qty: milliToString(l.qtyMilli),
        unitPricePaise: l.unitPricePaise, amountPaise: l.amountPaise, referenceUnitPricePaise: l.referenceUnitPricePaise })),
      totals: { itemsTotalPaise: q.totals.itemsTotalPaise, visitFeeCreditPaise: q.totals.visitFeeCreditPaise, discountPaise: q.totals.discountPaise,
        taxPaise: q.totals.taxPaise, totalPayablePaise: q.totals.totalPayablePaise },
    };
  }

  async #approvedOfJob(jobId: string): Promise<Row | null> {
    const q = (await this.#d.pool.query(SQL.quoteOfJob, [jobId])).rows[0] as Row | undefined;
    if (!q?.['approved_version_id']) return null;
    return (await this.#versionRow(q['approved_version_id'] as string)) ?? null;
  }

  /** POST /v1/technician/diagnoses/{id}/quote-preview: server-priced, nothing persisted. */
  async previewQuote(actor: Actor, diagnosisId: string) {
    const { d, facts } = await this.#ownDiagnosis(actor, diagnosisId);
    return this.#preview(d, facts);
  }

  async opsPreviewQuote(actor: Actor, diagnosisId: string) {
    const { d, facts } = await this.#opsDiagnosis(actor, diagnosisId);
    return this.#preview(d, facts);
  }

  async #preview(d: Row, facts: DiagnosisVisitFacts) {
    if (d['status'] !== 'DRAFT' || d['no_repair_needed'] === true) throw new AppError('INVALID_STATE');
    const approved = d['kind'] === 'ADDITIONAL_FINDING' ? await this.#approvedOfJob(facts.jobId) : null;
    const p = await this.#price(facts, d, (d['draft_lines'] as DraftLine[] | null) ?? [], approved, false);
    return { ...this.#view(p.priced), technicianEarningsPaise: p.priced.totals.technicianEarningsPaise, previewHash: p.hash.toString('hex') };
  }

  // ---------------------------------------------------------------- submission + presentation (04 §10, 06 §6–§7)

  /** POST /v1/technician/diagnoses/{id}/submit: re-priced on the server; a different result than the preview → 409. */
  async submitDiagnosis(actor: Actor, diagnosisId: string, input: { expectedVersion: number; previewHash?: string | undefined }, idempotencyKey: string,
    meta: RequestMeta) {
    const { d, facts } = await this.#ownDiagnosis(actor, diagnosisId);
    return this.#submit(d, facts, input, { type: 'TECHNICIAN', id: actor.id ?? null, channel: 'APP' }, actor, idempotencyKey, meta,
      'POST /v1/technician/diagnoses/:diagnosisId/submit');
  }

  async opsSubmitDiagnosis(actor: Actor, diagnosisId: string, input: { expectedVersion: number; previewHash?: string | undefined }, idempotencyKey: string,
    meta: RequestMeta) {
    const { d, facts } = await this.#opsDiagnosis(actor, diagnosisId);
    return this.#submit(d, facts, input, { type: 'ADMIN', id: actor.id ?? null, channel: 'OPS' }, actor, idempotencyKey, meta,
      'POST /admin/v1/diagnoses/:diagnosisId/submit');
  }

  async #submit(d: Row, facts: DiagnosisVisitFacts, input: { expectedVersion: number; previewHash?: string | undefined }, who: Who, actor: Actor,
    idempotencyKey: string, meta: RequestMeta, endpoint: string) {
    const actorKey = `${who.type === 'ADMIN' ? 'admin' : 'user'}:${actor.id ?? ''}`;
    const body = { diagnosisId: d['id'], ...input };
    // A replay must answer before the state checks below (the diagnosis is no longer a DRAFT after the first success).
    const replay = (await this.#d.pool.query(SQL.completedIdempotency, [actorKey, idempotencyKey])).rows[0];
    if (!replay) {
      if (d['status'] !== 'DRAFT') throw new AppError('INVALID_STATE');
      if (num(d['version']) !== input.expectedVersion) throw new AppError('STALE_VERSION');
      if (facts.status !== 'IN_PROGRESS') throw new AppError('INVALID_STATE');
    }
    const kind = d['kind'] as 'INITIAL' | 'ADDITIONAL_FINDING';
    const content = {
      problemCode: d['problem_code'] as string, observedChips: d['observed_chips'] as string[], severity: d['severity'] as DraftContent['severity'],
      safetyAdviceCode: (d['safety_advice_code'] as string | null) ?? null, items: (d['draft_lines'] as DraftLine[] | null) ?? [],
      noRepairNeeded: d['no_repair_needed'] === true, sameVisitFeasible: d['same_visit_feasible'] === true, materialAvailableNow: d['material_available_now'] === true,
    };
    let snapshot: { snapshotId: string; quote: PricedQuote; hash: Buffer } | null = null;
    let approved: Row | null = null;
    let options: { option: RepairOption; available: boolean; reasonKey: string | null }[] = [];
    let expiresAt: Date | null = null;
    if (!replay) {
      await this.#validated(facts, kind, content);
      approved = await this.#approvedOfJob(facts.jobId);
      // INITIAL only before any decision: after an approval new work is an ADDITIONAL_FINDING (change order); after a
      // rejection / expiry the job awaits payment of the visit fee (06 §2).
      const latest = (await this.#d.pool.query(SQL.versionsOfJob, [facts.jobId])).rows[0] as Row | undefined;
      if (kind === 'INITIAL' && (approved || (latest && ['REJECTED', 'EXPIRED', 'APPROVED', 'SUPERSEDED'].includes(latest['status'] as string)))) {
        throw new AppError('INVALID_STATE');
      }
      if (kind === 'ADDITIONAL_FINDING') {
        const job = await this.#d.jobs.quoteJobFacts(facts.jobId);
        if (!approved || job?.openRepairOrderStatus !== 'IN_PROGRESS') throw new AppError('INVALID_STATE');
      }
      if (!content.noRepairNeeded) {
        const preview = await this.#price(facts, d, content.items, approved, false);
        if (!input.previewHash || preview.hash.toString('hex') !== input.previewHash) throw new AppError('PRICE_RECALCULATED');
        // INV-21: the snapshot is written by pricing in its own transaction, before ours (B4).
        const persisted = await this.#price(facts, d, content.items, approved, true);
        if (!persisted.hash.equals(preview.hash) || !persisted.snapshotId) throw new AppError('PRICE_RECALCULATED');
        snapshot = { snapshotId: persisted.snapshotId, quote: persisted.priced, hash: persisted.hash };
        const rules = await this.#d.catalog.getServiceRules(facts.serviceTypeId, facts.cityId, this.#now());
        const now = this.#now();
        expiresAt = new Date(now.getTime() + (approved ? this.#d.policy.changeOrderExpiryMs
          : (rules?.quote_expiry_hours ? rules.quote_expiry_hours * 3_600_000 : this.#d.policy.defaultQuoteExpiryMs)));
        if (!approved) {
          const qualified = await this.#d.skills.repairQualified(facts.activeTechnicianUserId ?? '', d['required_repair_service_type_id'] as string,
            (d['required_repair_specialization_id'] as string | null) ?? null, now);
          options = repairOptions({ changeOrder: false, diagnosingTechnicianQualified: qualified, sameVisitAllowedByRule: rules?.same_visit_repair_allowed === true,
            sameVisitFeasible: content.sameVisitFeasible, materialAvailableNow: content.materialAvailableNow, visitStillInProgress: true, msSincePresentation: 0,
            sameVisitMaxWaitMs: this.#d.policy.sameVisitMaxWaitMs });
        }
      }
    }
    let delivery: { token: string; quoteVersionId: string; expiresAt: Date } | null = null;
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent<SubmitResult>(c, { actorKey, key: idempotencyKey, endpoint, body, ttlMs: TECH_IDEMPOTENCY_TTL_MS },
      async () => {
        const locked = (await c.query(SQL.lockDiagnosis, [d['id']])).rows[0] as Row;
        if (locked['status'] !== 'DRAFT') throw new AppError('INVALID_STATE');
        if (num(locked['version']) !== input.expectedVersion) throw new AppError('STALE_VERSION');
        const now = this.#now();
        await this.#context(c, who, meta);
        for (const line of content.items) {
          await c.query(SQL.insertDiagnosisItem, [newId(), d['id'], line.type, line.type === 'REPAIR_ITEM' ? line.repairItemId : null,
            line.type === 'MATERIAL' ? line.materialId : null, milliToString(toMilli(line.qty)), line.type === 'REPAIR_ITEM' ? null : (line.proposedUnitPricePaise ?? null),
            line.type === 'REPAIR_ITEM' ? null : (line.reasonCode ?? null)]);
        }
        // A correcting INITIAL diagnosis supersedes the earlier one, before any quote decision (06 §6).
        const earlier = kind === 'INITIAL' ? ((await c.query(SQL.submittedInitialOfJob, [facts.jobId, d['id']])).rows as Row[]) : [];
        await c.query(SQL.submitDiagnosis, [d['id'], now, earlier[0]?.['id'] ?? null]);
        for (const e of earlier) await c.query(SQL.supersedeDiagnosis, [e['id'], now]);
        await this.#event(c, 'DiagnosisSubmitted', 'Diagnosis', d['id'] as string, num(locked['version']) + 1, facts.cityId,
          { diagnosisId: d['id'] as string, jobId: facts.jobId, visitId: facts.visitId, kind, noRepairNeeded: content.noRepairNeeded }, meta);
        const auditActor = who.type === 'ADMIN' ? 'ADMIN' : 'TECHNICIAN';
        await this.#audit(c, { actorType: auditActor, actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'diagnosis.submitted',
          resourceType: 'diagnosis.diagnosis', resourceId: d['id'] as string, cityId: facts.cityId, outcome: 'SUCCESS',
          changeSummary: { kind, noRepairNeeded: content.noRepairNeeded, capturedBy: d['captured_by_actor_type'] as string } }, meta);
        if (!snapshot || !expiresAt) {
          return { status: 200, body: { diagnosisId: d['id'] as string, quoteVersionId: null, versionNo: null, totalPayablePaise: null, sameVisitOptionOffered: false } };
        }
        await c.query(SQL.ensureQuote, [newId(), facts.jobId]);
        const quote = (await c.query(SQL.lockQuoteOfJob, [facts.jobId])).rows[0] as Row;
        if ((quote['approved_version_id'] ?? null) !== (approved?.['id'] ?? null)) throw new AppError('QUOTE_CHANGED');
        const versionNo = num(quote['latest_version_no']) + 1;
        const versionId = newId();
        const t = snapshot.quote.totals;
        const diagnosisIds = [...(approved ? (approved['diagnosis_ids'] as string[]) : []), d['id'] as string];
        const withdrawn = (await c.query(SQL.withdrawPresented, [quote['id']])).rows as Row[];
        await c.query(SQL.insertVersion, [versionId, quote['id'], versionNo, diagnosisIds, who.type, actor.id, snapshot.snapshotId, t.itemsTotalPaise,
          t.discountPaise, t.visitFeeCreditPaise, t.taxPaise, t.totalPayablePaise, t.technicianEarningsPaise, snapshot.hash,
          (approved?.['id'] as string | undefined) ?? (withdrawn[0]?.['id'] as string | undefined) ?? null, now]);
        for (const l of snapshot.quote.lines) {
          await c.query(SQL.insertQuoteItem, [newId(), versionId, l.lineNo, l.itemType, l.repairItemId, l.materialId, l.labelKey, JSON.stringify(l.labelParams),
            milliToString(l.qtyMilli), l.unitPricePaise, l.amountPaise, l.referenceUnitPricePaise, l.deviationBps, l.deviationReasonCode, l.taxRateBps,
            l.technicianSharePaise]);
        }
        await c.query(SQL.presentVersion, [versionId, now, expiresAt]);
        await c.query(SQL.setLatestVersionNo, [quote['id'], versionNo]);
        for (const w of withdrawn) await cancelTimer(c, expiryKey(w['id'] as string));
        await scheduleTimer(c, { task: DIAGNOSIS_TIMER_TASKS.quoteExpire, key: expiryKey(versionId), runAt: expiresAt, payload: { quoteVersionId: versionId } });
        const link = newLinkToken();
        await c.query(SQL.insertLink, [newId(), versionId, link.hash, expiresAt, now]);
        delivery = { token: link.token, quoteVersionId: versionId, expiresAt };
        await this.#event(c, 'QuoteVersionPresented', 'Quote', quote['id'] as string, versionNo, facts.cityId, {
          jobId: facts.jobId, quoteId: quote['id'] as string, quoteVersionId: versionId, versionNo, changeOrder: approved !== null, visitId: facts.visitId,
          presentedAt: now.toISOString(), totalPayablePaise: t.totalPayablePaise, withdrawnVersionId: (withdrawn[0]?.['id'] as string | undefined) ?? null,
        }, meta);
        await this.#audit(c, { actorType: auditActor, actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'quote.version_presented',
          resourceType: 'diagnosis.quote_version', resourceId: versionId, cityId: facts.cityId, outcome: 'SUCCESS',
          changeSummary: { versionNo, changeOrder: approved !== null, totalPayablePaise: t.totalPayablePaise } }, meta);
        return { status: 200, body: { diagnosisId: d['id'] as string, quoteVersionId: versionId, versionNo, totalPayablePaise: t.totalPayablePaise,
          sameVisitOptionOffered: options.some((o) => o.option === 'SAME_VISIT' && o.available) } };
      }));
    // The link token leaves the process once, to the customer's channel; it is never stored in clear or logged (SR-05).
    const sent = delivery as { token: string; quoteVersionId: string; expiresAt: Date } | null;
    if (sent && !r.replayed) {
      await this.#d.links.deliver({ customerUserId: facts.customerUserId, ...sent }).catch(() => {
        this.#d.logger.log('warn', 'diagnosis.quote_link_delivery_failed', { outcome: 'FAILED' });
      });
    }
    return r.body;
  }

  // ---------------------------------------------------------------- quote views (04 §11)

  async #currentVersion(jobId: string): Promise<Row | undefined> {
    const versions = (await this.#d.pool.query(SQL.versionsOfJob, [jobId])).rows as Row[];
    return versions.find((v) => v['status'] === 'PRESENTED') ?? versions.find((v) => v['status'] === 'APPROVED') ?? versions[0];
  }

  async #optionsFor(v: Row, job: QuoteJobFacts): Promise<{ option: RepairOption; available: boolean; reasonKey: string | null }[]> {
    if (v['status'] !== 'PRESENTED' || v['approved_version_id'] !== null) return [];
    const init = (await this.#d.pool.query(SQL.initialDiagnosisOf, [v['diagnosis_ids']])).rows[0] as Row | undefined;
    if (!init) return [];
    const now = this.#now();
    const visit = await this.#d.jobs.diagnosisVisitFacts(init['visit_id'] as string);
    const rules = await this.#d.catalog.getServiceRules(job.serviceTypeId, job.cityId, now);
    const qualified = await this.#d.skills.repairQualified(init['technician_user_id'] as string, init['required_repair_service_type_id'] as string,
      (init['required_repair_specialization_id'] as string | null) ?? null, now);
    return repairOptions({ changeOrder: false, diagnosingTechnicianQualified: qualified, sameVisitAllowedByRule: rules?.same_visit_repair_allowed === true,
      sameVisitFeasible: init['same_visit_feasible'] === true, materialAvailableNow: init['material_available_now'] === true,
      visitStillInProgress: visit?.status === 'IN_PROGRESS' && visit.purposes.length === 1 && visit.purposes[0] === 'DIAGNOSIS'
        && visit.activeTechnicianUserId === init['technician_user_id'],
      msSincePresentation: now.getTime() - (v['presented_at'] as Date).getTime(), sameVisitMaxWaitMs: this.#d.policy.sameVisitMaxWaitMs });
  }

  async #quoteView(v: Row, job: QuoteJobFacts, withOptions: boolean) {
    const items = (await this.#d.pool.query(SQL.quoteItems, [v['id']])).rows as Row[];
    const previous = v['approved_version_id'] && v['approved_version_id'] !== v['id'] ? await this.#versionRow(v['approved_version_id'] as string) : undefined;
    return {
      quoteVersionId: v['id'] as string, versionNo: num(v['version_no']), status: v['status'] as string, contentHash: (v['content_hash'] as Buffer).toString('hex'),
      presentedAt: (v['presented_at'] as Date | null)?.toISOString() ?? null, expiresAt: (v['expires_at'] as Date | null)?.toISOString() ?? null,
      lines: items.map((i) => ({ lineNo: num(i['line_no']), type: i['item_type'] as string, labelKey: i['label_key'] as string, labelParams: i['label_params'],
        qty: String(i['qty']), unitPricePaise: num(i['unit_price_paise']), amountPaise: num(i['amount_paise']),
        referenceUnitPricePaise: i['reference_unit_price_paise'] === null ? null : num(i['reference_unit_price_paise']) })),
      totals: { itemsTotalPaise: num(v['items_total_paise']), visitFeeCreditPaise: num(v['visit_fee_credit_paise']), discountPaise: num(v['discount_paise']),
        taxPaise: num(v['tax_paise']), totalPayablePaise: num(v['total_payable_paise']) },
      repairOptions: withOptions ? await this.#optionsFor(v, job) : [],
      ...(previous ? { previousApproved: { versionNo: num(previous['version_no']), totalPayablePaise: num(previous['total_payable_paise']) } } : {}),
    };
  }

  /** GET /v1/customer/jobs/{jobId}/quote: the owner's current quote (the PRESENTED version, else the approved one). */
  async getCustomerQuote(actor: Actor, jobId: string) {
    const job = UUID.test(jobId) ? await this.#d.jobs.quoteJobFacts(jobId) : null;
    this.#require(actor, 'diagnosis.quote.read_customer', { ownerUserId: job?.customerUserId ?? null });
    const v = await this.#currentVersion(jobId);
    if (!v || !job) throw new AppError('NOT_FOUND');
    return this.#quoteView(v, job, true);
  }

  /** GET /v1/technician/visits/{visitId}/quote: the assigned technician sees the quote (view only, 05 §4.2). */
  async getTechnicianQuote(actor: Actor, visitId: string) {
    const facts = UUID.test(visitId) ? await this.#d.jobs.diagnosisVisitFacts(visitId) : null;
    this.#require(actor, 'diagnosis.quote.read_technician', { isAssignee: facts !== null && actor.id !== undefined && facts.activeTechnicianUserId === actor.id });
    const job = await this.#d.jobs.quoteJobFacts((facts as DiagnosisVisitFacts).jobId);
    const v = await this.#currentVersion((facts as DiagnosisVisitFacts).jobId);
    if (!v || !job) throw new AppError('NOT_FOUND');
    return this.#quoteView(v, job, false);
  }

  // ---------------------------------------------------------------- decisions (INV-06, INV-07, INV-08)

  /** POST /v1/customer/quote-versions/{id}/approve: own session, hash-bound, option available, step-up above the threshold. */
  async approveQuote(actor: Actor, versionId: string, input: DecisionInput & { repairPreference: RepairOption; allowFallback: boolean }, idempotencyKey: string,
    meta: RequestMeta) {
    const { v, job } = await this.#ownVersion(actor, versionId);
    return this.#decide(v, job, 'APPROVED', input, { channel: 'APP_SESSION', customerUserId: actor.id ?? '', sessionId: actor.sessionId ?? null },
      { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, actor, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
        endpoint: 'POST /v1/customer/quote-versions/:quoteVersionId/approve' }, meta);
  }

  async rejectQuote(actor: Actor, versionId: string, input: DecisionInput & { reasonCode: string }, idempotencyKey: string, meta: RequestMeta) {
    const { v, job } = await this.#ownVersion(actor, versionId);
    return this.#decide(v, job, 'REJECTED', input, { channel: 'APP_SESSION', customerUserId: actor.id ?? '', sessionId: actor.sessionId ?? null },
      { type: 'CUSTOMER', id: actor.id ?? null, channel: 'PWA' }, actor, { actorKey: `user:${actor.id ?? ''}`, key: idempotencyKey,
        endpoint: 'POST /v1/customer/quote-versions/:quoteVersionId/reject' }, meta);
  }

  async #ownVersion(actor: Actor, versionId: string): Promise<{ v: Row; job: QuoteJobFacts }> {
    const v = await this.#versionRow(versionId);
    const job = v ? await this.#d.jobs.quoteJobFacts(v['job_id'] as string) : null;
    this.#require(actor, 'diagnosis.quote.decide', { ownerUserId: job?.customerUserId ?? null });
    if (!v || !job) throw new AppError('NOT_FOUND');
    return { v, job };
  }

  /**
   * One decision per version, inside one transaction: the version must be the PRESENTED one, unexpired, with the hash
   * the customer saw (the DB re-checks INV-06); an approval supersedes the earlier approved version (change order,
   * INV-07). Repair orders follow from the QuoteApproved event (jobs).
   */
  async #decide(v0: Row, job: QuoteJobFacts, decision: 'APPROVED' | 'REJECTED', input: DecisionInput, evidence: Evidence, who: Who, actor: Actor | null,
    idem: { actorKey: string; key: string; endpoint: string }, meta: RequestMeta) {
    const changeOrder = v0['approved_version_id'] !== null && v0['approved_version_id'] !== v0['id'];
    const init = (await this.#d.pool.query(SQL.initialDiagnosisOf, [v0['diagnosis_ids']])).rows[0] as Row | undefined;
    if (!init) throw new AppError('INVALID_STATE');
    // Preferences: a change order keeps the order's performer (the previous approval's preference); a first approval
    // must pick an available option (02 §4).
    let preference: RepairOption | null = null;
    let preferredTechnician: string | null = null;
    let allowFallback: boolean | null = null;
    let window: { start: Date; end: Date } | null = null;
    if (decision === 'APPROVED') {
      if (changeOrder) {
        const prior = (await this.#d.pool.query(SQL.decisionOf, [v0['approved_version_id']])).rows[0] as Row | undefined;
        preference = (prior?.['repair_preference'] as RepairOption | null) ?? 'RECOMMENDED_SPECIALIST';
        preferredTechnician = (prior?.['preferred_technician_user_id'] as string | null) ?? null;
        allowFallback = (prior?.['allow_fallback'] as boolean | null) ?? true;
      } else {
        if (!input.repairPreference) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'repairPreference', code: 'REQUIRED' }] });
        const options = await this.#optionsFor(v0, job);
        if (v0['status'] === 'PRESENTED' && !options.find((o) => o.option === input.repairPreference)?.available) throw new AppError('OPTION_UNAVAILABLE');
        preference = input.repairPreference;
        preferredTechnician = preference === 'RECOMMENDED_SPECIALIST' ? null : (init['technician_user_id'] as string);
        allowFallback = input.allowFallback ?? true;
        if (input.preferredWindow) {
          const start = new Date(input.preferredWindow.start);
          const end = new Date(input.preferredWindow.end);
          if (!(start.getTime() < end.getTime()) || end.getTime() <= this.#now().getTime()) {
            throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'preferredWindow', code: 'INVALID' }] });
          }
          window = { start, end };
        }
      }
      // High-value approvals need a fresh step-up OTP on the session channel (05 §2.1); the link channel's OTP is one.
      if (evidence.channel === 'APP_SESSION' && num(v0['total_payable_paise']) > this.#d.policy.highValueThresholdPaise
        && !(actor && recentStepUp(actor, this.#now(), this.#d.policy.stepUpValidityMs))) {
        throw new AppError('STEP_UP_REQUIRED');
      }
    } else if (!input.reasonCode) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'reasonCode', code: 'REQUIRED' }] });
    const r = await withTransaction(this.#d.pool, (c) => this.#idempotent(c, { ...idem, body: { versionId: v0['id'], decision, input } }, async () => {
      const quote = (await c.query(SQL.lockQuote, [v0['quote_id']])).rows[0] as Row;
      const v = (await c.query(SQL.lockVersion, [v0['id']])).rows[0] as Row;
      const now = this.#now();
      if (v['status'] === 'EXPIRED' || (v['status'] === 'PRESENTED' && (v['expires_at'] as Date).getTime() <= now.getTime())) {
        throw new AppError('QUOTE_EXPIRED');
      }
      if (v['status'] !== 'PRESENTED') throw new AppError('QUOTE_CHANGED', { details: { latestVersionNo: num(quote['latest_version_no']) } });
      if (!(v['content_hash'] as Buffer).equals(Buffer.from(input.contentHash, 'hex'))) {
        throw new AppError('QUOTE_CHANGED', { details: { latestVersionNo: num(quote['latest_version_no']) } });
      }
      if ((quote['approved_version_id'] ?? null) !== (v0['approved_version_id'] ?? null)) throw new AppError('QUOTE_CHANGED');
      if (evidence.linkId && (await c.query(SQL.useLink, [evidence.linkId, now])).rowCount !== 1) throw new AppError('INVALID_STATE');
      await this.#context(c, who, meta, decision === 'REJECTED' ? (input.reasonCode ?? null) : null);
      await c.query(SQL.insertDecision, [newId(), v0['id'], decision, v['content_hash'], evidence.channel, evidence.customerUserId, evidence.sessionId ?? null,
        null, evidence.otpChallengeId ?? null, evidence.callSessionId ?? null, evidence.recorderAdminId ?? null, evidence.verifierAdminId ?? null,
        evidence.capturerAdminId ?? null, preference, preferredTechnician, allowFallback, window?.start ?? null, window?.end ?? null,
        decision === 'REJECTED' ? (input.reasonCode ?? null) : null, now]);
      let supersededVersionId: string | null = null;
      if (decision === 'APPROVED') {
        if (quote['approved_version_id']) {
          supersededVersionId = quote['approved_version_id'] as string;
          await c.query(SQL.supersedeVersion, [supersededVersionId]);
        }
        await c.query(SQL.decideVersion, [v0['id'], 'APPROVED', now]);
        await c.query(SQL.setApprovedVersion, [quote['id'], v0['id']]);
      } else {
        await c.query(SQL.decideVersion, [v0['id'], 'REJECTED', now]);
      }
      await cancelTimer(c, expiryKey(v0['id'] as string));
      const payload = { jobId: job.jobId, quoteId: quote['id'] as string, quoteVersionId: v0['id'] as string, versionNo: num(v['version_no']), changeOrder,
        visitId: init['visit_id'] as string, repairPreference: preference, channel: evidence.channel, supersededVersionId };
      await this.#event(c, decision === 'APPROVED' ? 'QuoteApproved' : 'QuoteRejected', 'Quote', quote['id'] as string, num(v['version_no']), job.cityId, payload, meta);
      if (supersededVersionId) {
        await this.#event(c, 'QuoteVersionSuperseded', 'Quote', quote['id'] as string, num(v['version_no']), job.cityId,
          { quoteId: quote['id'] as string, quoteVersionId: supersededVersionId, supersededBy: v0['id'] as string }, meta);
      }
      await this.#audit(c, { actorType: who.type === 'SYSTEM' ? 'SYSTEM' : who.type, actorId: who.id, actorSessionId: actor?.sessionId ?? null,
        action: decision === 'APPROVED' ? 'quote.approved' : 'quote.rejected', resourceType: 'diagnosis.quote_version', resourceId: v0['id'] as string,
        cityId: job.cityId, outcome: 'SUCCESS', reasonCode: decision === 'REJECTED' ? (input.reasonCode ?? null) : null,
        changeSummary: { channel: evidence.channel, changeOrder, repairPreference: preference, totalPayablePaise: num(v['total_payable_paise']) } }, meta);
      return { status: 200, body: { quoteVersionId: v0['id'] as string, status: decision, repairPreference: preference } };
    }));
    return r.body;
  }

  // ---------------------------------------------------------------- signed link + OTP (SR-05, ADR-027 #13)

  async #link(token: string): Promise<{ link: Row; v: Row; job: QuoteJobFacts }> {
    const link = /^[A-Za-z0-9_-]{43}$/.test(token) ? ((await this.#d.pool.query(SQL.linkByHash, [linkTokenHash(token)])).rows[0] as Row | undefined) : undefined;
    // Wrong, expired or used links all look the same (no oracle).
    if (!link || (link['expires_at'] as Date).getTime() <= this.#now().getTime() || link['used_at'] !== null) throw new AppError('NOT_FOUND');
    const v = await this.#versionRow(link['quote_version_id'] as string);
    const job = await this.#d.jobs.quoteJobFacts(link['job_id'] as string);
    if (!v || !job) throw new AppError('NOT_FOUND');
    return { link, v, job };
  }

  /** POST /v1/links/quotes/view: the minimal quote view (no address, no names); link-preview agents get a generic page. */
  async viewLink(input: { token: string }, userAgent: string | undefined) {
    if (isLinkPreviewAgent(userAgent)) return { generic: true as const };
    const { v, job } = await this.#link(input.token);
    return { generic: false as const, quote: await this.#quoteView(v, job, true) };
  }

  /** POST /v1/links/quotes/otp: the code goes to the job customer's registered number, never to a number in the request. */
  async requestLinkOtp(input: { token: string }, meta: RequestMeta) {
    const { v, job } = await this.#link(input.token);
    if (v['status'] !== 'PRESENTED') throw new AppError('QUOTE_CHANGED');
    return this.#d.otp.requestQuoteApprovalOtp(job.customerUserId, meta);
  }

  /** POST /v1/links/quotes/decision: OTP-verified, single successful decision per link (a replay is 409). */
  async linkDecision(input: { token: string; challengeId: string; code: string; decision: 'APPROVE' | 'REJECT' } & DecisionInput, meta: RequestMeta) {
    const { link, v, job } = await this.#link(input.token);
    if (!(await this.#d.otp.verifyQuoteApprovalOtp(job.customerUserId, { challengeId: input.challengeId, code: input.code }, meta))) throw new AppError('OTP_INVALID');
    const tokenRef = (link['id'] as string).replaceAll('-', '');
    return this.#decide(v, job, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', input,
      { channel: 'SIGNED_LINK_OTP', customerUserId: job.customerUserId, otpChallengeId: input.challengeId, linkId: link['id'] as string },
      { type: 'CUSTOMER', id: job.customerUserId, channel: 'SIGNED_LINK' }, null,
      { actorKey: `anon:quote-link-${tokenRef}`, key: input.challengeId, endpoint: 'POST /v1/links/quotes/decision' }, meta);
  }

  // ---------------------------------------------------------------- ops-recorded decision (INV-08, G-9; flag-off, D-11)

  /**
   * The accessibility fallback (02 INV-08, D-11 pending, D-15 pending): OFF unless the policy enables it. A recorder and a
   * different verifier (both `support.record_approval` for the city, the verifier freshly stepped up), neither of whom
   * captured the diagnosis (G-9); a total within the cap; the customer read back the code sent to their registered number
   * on the recorded call. The verifier workflow (how the second person is involved) is a pending founder decision.
   */
  async recordOpsDecision(recorder: Actor, verifier: Actor, input: DecisionInput & { quoteVersionId: string; decision: 'APPROVE' | 'REJECT';
    callSessionId: string; otpChallengeId: string; otpCode: string }, idempotencyKey: string, meta: RequestMeta) {
    if (!this.#d.policy.opsRecordedApprovalEnabled) throw new AppError('FEATURE_DISABLED');
    const v = await this.#versionRow(input.quoteVersionId);
    const job = v ? await this.#d.jobs.quoteJobFacts(v['job_id'] as string) : null;
    if (!v || !job) throw new AppError('NOT_FOUND');
    this.#require(recorder, 'diagnosis.quote.record_decision', { cityId: job.cityId });
    this.#require(verifier, 'diagnosis.quote.record_decision', { cityId: job.cityId });
    if (!recorder.id || !verifier.id || recorder.id === verifier.id) throw new AppError('FORBIDDEN');
    if (!recentStepUp(verifier, this.#now(), this.#d.policy.stepUpValidityMs)) throw new AppError('STEP_UP_REQUIRED');
    if (num(v['total_payable_paise']) > this.#d.policy.opsRecordedApprovalMaxPaise) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'quoteVersionId', code: 'ABOVE_RECORDED_APPROVAL_CAP' }] });
    }
    const init = (await this.#d.pool.query(SQL.initialDiagnosisOf, [v['diagnosis_ids']])).rows[0] as Row | undefined;
    const capturer = init?.['captured_by_actor_type'] === 'OPS_AGENT' ? (init['captured_by_actor_id'] as string) : null;
    if (capturer !== null && (capturer === recorder.id || capturer === verifier.id)) throw new AppError('FORBIDDEN'); // G-9 (DB CHECK too)
    if (!(await this.#d.callEvidence.recordedCustomerCall(input.callSessionId, { jobId: job.jobId, customerUserId: job.customerUserId }))) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'callSessionId', code: 'NO_RECORDED_CALL' }] });
    }
    if (!(await this.#d.otp.verifyQuoteApprovalOtp(job.customerUserId, { challengeId: input.otpChallengeId, code: input.otpCode }, meta))) {
      throw new AppError('OTP_INVALID');
    }
    return this.#decide(v, job, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', input, { channel: 'OPS_RECORDED_CALL', customerUserId: job.customerUserId,
      callSessionId: input.callSessionId, otpChallengeId: input.otpChallengeId, recorderAdminId: recorder.id, verifierAdminId: verifier.id, capturerAdminId: capturer },
    { type: 'ADMIN', id: recorder.id, channel: 'OPS_RECORDED_CALL' }, recorder,
    { actorKey: `admin:${recorder.id}`, key: idempotencyKey, endpoint: 'diagnosis.quote.recorded_decision' }, meta);
  }

  // ---------------------------------------------------------------- expiry (06 §2: T:quote_expire) and the sweeper

  /** PRESENTED past its expiry → EXPIRED (visit fee due for a first quote; a change order leaves the approved scope). */
  async onQuoteExpire(versionId: string): Promise<boolean> {
    return withTransaction(this.#d.pool, async (c) => {
      const v0 = (await c.query(SQL.version, [versionId])).rows[0] as Row | undefined;
      if (!v0 || v0['status'] !== 'PRESENTED') return false;
      const quote = (await c.query(SQL.lockQuote, [v0['quote_id']])).rows[0] as Row;
      const v = (await c.query(SQL.lockVersion, [versionId])).rows[0] as Row;
      const now = this.#now();
      if (v['status'] !== 'PRESENTED') return false;
      if ((v['expires_at'] as Date).getTime() > now.getTime()) {
        await scheduleTimer(c, { task: DIAGNOSIS_TIMER_TASKS.quoteExpire, key: expiryKey(versionId), runAt: v['expires_at'] as Date, payload: { quoteVersionId: versionId } });
        return false;
      }
      const init = (await c.query(SQL.initialDiagnosisOf, [v['diagnosis_ids']])).rows[0] as Row | undefined;
      const job = await this.#d.jobs.quoteJobFacts(quote['job_id'] as string);
      await this.#context(c, SYSTEM, null, 'QUOTE_EXPIRED');
      await c.query(SQL.expireVersion, [versionId, now]);
      await this.#event(c, 'QuoteExpired', 'Quote', quote['id'] as string, num(v['version_no']), job?.cityId ?? null, {
        jobId: quote['job_id'] as string, quoteId: quote['id'] as string, quoteVersionId: versionId, versionNo: num(v['version_no']),
        changeOrder: quote['approved_version_id'] !== null, visitId: (init?.['visit_id'] as string | undefined) ?? '',
      }, null);
      return true;
    });
  }

  async sweep(limit = 100): Promise<{ quoteExpire: number }> {
    let n = 0;
    for (const r of (await this.#d.pool.query(SQL.overdueVersions, [this.#now(), limit])).rows as Row[]) if (await this.onQuoteExpire(r['id'] as string)) n += 1;
    return { quoteExpire: n };
  }

  timerTasks(): Record<string, (payload: unknown) => Promise<void>> {
    return {
      [DIAGNOSIS_TIMER_TASKS.quoteExpire]: async (p: unknown) => {
        const id = (p as { quoteVersionId?: unknown } | null)?.quoteVersionId;
        if (typeof id === 'string' && UUID.test(id)) await this.onQuoteExpire(id);
      },
      [DIAGNOSIS_TIMER_TASKS.sweep]: async () => {
        await this.sweep();
      },
    };
  }

  // ---------------------------------------------------------------- ports provided to jobs (ADR-027)

  /**
   * TCP-2 (ADR-022, ADR-027 #7): runs on the jobs transaction's connection (diagnosis SQL only). Locks the quote, then
   * refuses unless the repair order's version is the quote's APPROVED version and no change order is PRESENTED - the
   * INV-04 approved-quote half, checked in the same transaction as the completion - and records the usage (≤ quoted).
   */
  materialUsageRecorder(): MaterialUsageRecorder {
    return {
      recordMaterialUsage: async (tx: TransactionContext, input) => {
        const c = tx.db;
        const quote = (await c.query(SQL.lockQuoteOfVersion, [input.quoteVersionId])).rows[0] as Row | undefined;
        if (!quote || quote['approved_version_id'] !== input.quoteVersionId) throw new AppError('INVALID_STATE');
        if ((await c.query(SQL.presentedOfQuote, [quote['id']])).rows.length > 0) throw new AppError('CHANGE_PENDING');
        const items = new Map(((await c.query(SQL.materialItems, [input.quoteVersionId])).rows as Row[]).map((r) => [r['id'] as string, r]));
        for (const line of input.lines) {
          const item = items.get(line.quoteItemId);
          if (!item) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'materialUsage.quoteItemId', code: 'NOT_A_QUOTED_MATERIAL' }] });
          await c.query(SQL.insertUsage, [newId(), input.repairOrderId, input.visitId, line.quoteItemId, item['material_id'], item['qty'],
            milliToString(toMilli(line.qtyUsed)), line.actualUnitCostPaise, input.recordedBy.actorType, input.recordedBy.actorId, this.#now()]);
        }
      },
    };
  }

  /** Read-only facts for jobs (quote versions for repair orders and completion; diagnosis-visit checkout). */
  repairQuotes(): RepairQuotes {
    return {
      versionFacts: async (versionId: string): Promise<ApprovedQuoteFacts | null> => {
        const v = await this.#versionRow(versionId);
        if (!v) return null;
        const init = (await this.#d.pool.query(SQL.initialDiagnosisOf, [v['diagnosis_ids']])).rows[0] as Row | undefined;
        if (!init) return null;
        const decision = (await this.#d.pool.query(SQL.decisionOf, [versionId])).rows[0] as Row | undefined;
        const materials = ((await this.#d.pool.query(SQL.quoteItems, [versionId])).rows as Row[]).filter((i) => i['item_type'] === 'MATERIAL')
          .map((i) => ({ quoteItemId: i['id'] as string, materialId: i['material_id'] as string, qtyMilli: toMilli(Number(i['qty'])),
            unitPricePaise: num(i['unit_price_paise']) }));
        const rateCardId = await this.#d.pricing.snapshotRateCardId(v['price_snapshot_id'] as string);
        if (!rateCardId) return null;
        const ws = (decision?.['window_start'] as Date | null) ?? null;
        const we = (decision?.['window_end'] as Date | null) ?? null;
        return {
          quoteId: v['quote_id'] as string, quoteVersionId: versionId, versionNo: num(v['version_no']), jobId: v['job_id'] as string, status: v['status'] as string,
          rateCardId, totalPayablePaise: num(v['total_payable_paise']), presentedAt: v['presented_at'] as Date, decidedAt: (v['decided_at'] as Date | null) ?? null,
          repairPreference: (decision?.['repair_preference'] as ApprovedQuoteFacts['repairPreference']) ?? null,
          preferredTechnicianUserId: (decision?.['preferred_technician_user_id'] as string | null) ?? null,
          allowFallback: (decision?.['allow_fallback'] as boolean | null) ?? true, preferredWindow: ws && we ? { start: ws, end: we } : null,
          requiredServiceTypeId: init['required_repair_service_type_id'] as string, requiredSpecializationId: (init['required_repair_specialization_id'] as string | null) ?? null,
          materials, materialAvailableNow: init['material_available_now'] === true, diagnosingVisitId: init['visit_id'] as string,
          diagnosingTechnicianUserId: init['technician_user_id'] as string,
        };
      },
      diagnosisCheckout: async (visitId: string) => {
        const r = UUID.test(visitId) ? ((await this.#d.pool.query(SQL.checkoutFacts, [visitId])).rows[0] as Row | undefined) : undefined;
        return { submitted: r !== undefined, quotePresented: r?.['presented'] === true, noRepairNeeded: r?.['no_repair_needed'] === true };
      },
    };
  }
}
