// Pure diagnosis / quote rules (Phase 1 06 §6–§7, 02 §4 Q-A, SR-05, ADR-027). No I/O; the service supplies the facts.
import { createHash, randomBytes } from 'node:crypto';

/** Diagnosis and quote policy values: FIXTURE VALUES, NOT FINAL (configuration once the config module exists). */
export interface DiagnosisPolicy {
  /** Quote expiry when the service rule sets no `quote_expiry_hours` (06 §2: e.g. 48 h). */
  readonly defaultQuoteExpiryMs: number;
  /** A change order presented while the technician is on site expires sooner (06 §8: e.g. 60 min). */
  readonly changeOrderExpiryMs: number;
  /** Approving a quote above this total needs a fresh OTP step-up (05 §2.1, 04 §11). */
  readonly highValueThresholdPaise: number;
  /** Step-up freshness (05 §2.1: within 10 min). */
  readonly stepUpValidityMs: number;
  /** Same-visit option: the approval must come within this time of the presentation (06 §3: e.g. 45 min). */
  readonly sameVisitMaxWaitMs: number;
  /** Ops-recorded approval (INV-08, D-11 pending): disabled by default; when enabled, totals up to the cap only. */
  readonly opsRecordedApprovalEnabled: boolean;
  readonly opsRecordedApprovalMaxPaise: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const FIXTURE_DIAGNOSIS_POLICY: DiagnosisPolicy = Object.freeze({
  defaultQuoteExpiryMs: 48 * HOUR,
  changeOrderExpiryMs: 60 * MIN,
  highValueThresholdPaise: 300_000,
  stepUpValidityMs: 10 * MIN,
  sameVisitMaxWaitMs: 45 * MIN,
  opsRecordedApprovalEnabled: false,
  opsRecordedApprovalMaxPaise: 100_000,
});

/** Diagnosis state machine (06 §6). A DB trigger enforces the same moves (migration 0014). */
export const DIAGNOSIS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['SUBMITTED', 'VOIDED'],
  SUBMITTED: ['SUPERSEDED', 'VOIDED'],
  SUPERSEDED: [],
  VOIDED: [],
};

/** Quote version state machine (06 §7, D11). A DB trigger enforces the same moves (migration 0037). */
export const QUOTE_VERSION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['PRESENTED', 'WITHDRAWN'],
  PRESENTED: ['APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
  APPROVED: ['SUPERSEDED'],
  REJECTED: [],
  EXPIRED: [],
  WITHDRAWN: [],
  SUPERSEDED: [],
};

export function canMove(table: Readonly<Record<string, readonly string[]>>, from: string, to: string): boolean {
  return (table[from] ?? []).includes(to);
}

/** Canonical JSON: sorted object keys, no whitespace (stable across runs and platforms). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface HashedLine {
  readonly lineNo: number;
  readonly itemType: string;
  readonly repairItemId: string | null;
  readonly materialId: string | null;
  readonly labelKey: string;
  readonly labelParams: Readonly<Record<string, string>>;
  readonly qty: string;
  readonly unitPricePaise: number;
  readonly amountPaise: number;
}

export interface HashedTotals {
  readonly itemsTotalPaise: number;
  readonly discountPaise: number;
  readonly visitFeeCreditPaise: number;
  readonly taxPaise: number;
  readonly totalPayablePaise: number;
}

/**
 * The content hash (03 §11): SHA-256 over the canonical JSON of the lines (with their locale text keys) and the totals -
 * exactly what the customer sees. An approval must carry it (INV-06); any change of a line or total changes it.
 */
export function quoteContentHash(lines: readonly HashedLine[], totals: HashedTotals): Buffer {
  const content = {
    lines: lines.map((l) => ({ lineNo: l.lineNo, itemType: l.itemType, repairItemId: l.repairItemId, materialId: l.materialId, labelKey: l.labelKey,
      labelParams: l.labelParams, qty: l.qty, unitPricePaise: l.unitPricePaise, amountPaise: l.amountPaise })),
    totals: { itemsTotalPaise: totals.itemsTotalPaise, discountPaise: totals.discountPaise, visitFeeCreditPaise: totals.visitFeeCreditPaise,
      taxPaise: totals.taxPaise, totalPayablePaise: totals.totalPayablePaise },
  };
  return createHash('sha256').update(canonicalJson(content)).digest();
}

/** SR-05: a 256-bit single-version link token (base64url) and the hash that is the only thing stored. */
export function newLinkToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: linkTokenHash(token) };
}

export function linkTokenHash(token: string): Buffer {
  return createHash('sha256').update(`quote-link|${token}`).digest();
}

/** Link-preview user agents get a generic page (SR-05): they never see quote content. */
export function isLinkPreviewAgent(userAgent: string | undefined): boolean {
  return /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|embedly|linkedin/i.test(userAgent ?? '');
}

export type RepairOption = 'SAME_VISIT' | 'SAME_TECHNICIAN' | 'RECOMMENDED_SPECIALIST';

export interface RepairOptionFacts {
  readonly changeOrder: boolean;
  /** The diagnosing technician holds a verified repair skill for the required type / specialization. */
  readonly diagnosingTechnicianQualified: boolean;
  readonly sameVisitAllowedByRule: boolean;
  readonly sameVisitFeasible: boolean;
  readonly materialAvailableNow: boolean;
  /** The diagnosis visit is still IN_PROGRESS with the diagnosing technician. */
  readonly visitStillInProgress: boolean;
  readonly msSincePresentation: number;
  readonly sameVisitMaxWaitMs: number;
}

/**
 * The repair options offered with a quote (02 §4, Q-A). Qualified diagnosing technician: same visit now (when every
 * same-visit guard holds), same technician later, and a specialist. Not qualified: the recommended specialist only. A
 * change order offers no choice: the repair order already has its performer.
 */
export function repairOptions(f: RepairOptionFacts): { option: RepairOption; available: boolean; reasonKey: string | null }[] {
  if (f.changeOrder) return [];
  const sameVisitReason = !f.diagnosingTechnicianQualified ? 'quote.option.reason.technician_not_qualified'
    : !f.sameVisitAllowedByRule ? 'quote.option.reason.not_allowed_for_service'
      : !f.sameVisitFeasible || !f.materialAvailableNow ? 'quote.option.reason.material_not_available'
        : !f.visitStillInProgress ? 'quote.option.reason.technician_left'
          : f.msSincePresentation > f.sameVisitMaxWaitMs ? 'quote.option.reason.too_late' : null;
  return [
    { option: 'SAME_VISIT', available: sameVisitReason === null, reasonKey: sameVisitReason },
    { option: 'SAME_TECHNICIAN', available: f.diagnosingTechnicianQualified,
      reasonKey: f.diagnosingTechnicianQualified ? null : 'quote.option.reason.technician_not_qualified' },
    { option: 'RECOMMENDED_SPECIALIST', available: true, reasonKey: null },
  ];
}
