// Ports owned by the jobs module (ADR-022, ADR-026, ADR-027). Callee modules implement these; apps wire them. jobs never
// imports diagnosis, payments, workforce or customers internals, so the compile-time graph stays acyclic and B4 holds:
// only TCP-2 / TCP-3 calls run inside a jobs transaction (they receive the caller's connection in the context).
import type { Queryable } from '@hsp/db';
import type { LifecycleFeeRules } from '@hsp/module-pricing';

/** Handle to the caller's open database transaction. Only a TCP callee may use `db`, for its own schema (B2, B4). */
export interface TransactionContext {
  readonly transactionId: string;
  readonly db: Queryable;
}

/**
 * TCP-2 (Gate 6, ADR-027 #7): record the materials actually used in the same transaction as repair completion. The
 * callee re-checks, under its own row lock, that the repair order's version is still the quote's APPROVED version and
 * that no change order is pending (the INV-04 approved-quote half), and refuses usage above the quoted quantity.
 */
export interface MaterialUsageRecorder {
  recordMaterialUsage(
    tx: TransactionContext,
    input: {
      readonly repairOrderId: string;
      readonly visitId: string;
      readonly quoteVersionId: string;
      readonly recordedBy: { readonly actorType: 'TECHNICIAN' | 'ADMIN'; readonly actorId: string };
      readonly lines: readonly { readonly quoteItemId: string; readonly qtyUsed: number; readonly actualUnitCostPaise: number | null }[];
    },
  ): Promise<void>;
}

export type BillKind = 'CANCELLATION_FEE' | 'NO_SHOW_FEE' | 'VISIT_FEE' | 'REPAIR_COMPLETION';

/**
 * TCP-3: issue the deterministic bill in the same transaction as the jobs command that makes money due (G-1): repair
 * completion, closing without repair (no repair needed, quote rejected / expired), a cancellation with a fee, a customer
 * no-show. The bill is a pure function of the referenced immutable price snapshot. A deterministic placeholder until
 * Gate 11 replaces it with the real implementation.
 */
export interface BillIssuer {
  issueBill(
    tx: TransactionContext,
    input: { readonly jobId: string; readonly visitId: string; readonly kind: BillKind; readonly priceSnapshotId: string },
  ): Promise<{ readonly billId: string; readonly amountDuePaise: bigint }>;
}

/** customers (read-only, ADR-026 #2). */
export interface AddressBook {
  addressForBooking(customerUserId: string, addressId: string): Promise<{
    readonly addressId: string; readonly cityId: string; readonly zoneId: string; readonly localityId: string;
    readonly serviceable: boolean; readonly snapshot: Buffer;
  } | null>;
  openAddressSnapshot(customerUserId: string, snapshot: Buffer): Promise<{
    readonly line1: string; readonly line2: string | null; readonly landmark: string; readonly accessNotes: string | null;
  }>;
}

/** catalog: what a city offers (ADR-025 #8) and its service rules (same-visit repair allowed, 06 §3). */
export interface ServiceOffer {
  isOffered(serviceTypeId: string, cityId: string, at?: Date): Promise<boolean>;
  symptomCodes(serviceTypeId: string): Promise<readonly string[]>;
  getServiceRules(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly same_visit_repair_allowed?: boolean | undefined } | null>;
}

/** pricing (read-only, ADR-026 #1). Snapshots are written in pricing's own transaction (B4). */
export interface LifecyclePricing {
  visitFee(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly amountPaise: number } | null>;
  snapshotVisitFee(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly snapshotId: string; readonly amountPaise: number } | null>;
  lifecycleFeeRules(cityId: string, at?: Date): Promise<LifecycleFeeRules | null>;
  snapshot(input: { rateCardId: string; ruleRefs: Record<string, unknown>; inputs: Record<string, unknown>; outputs: Record<string, unknown> }): Promise<string>;
  snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null>;
}

/** workforce (read-only): an ACTIVE technician's city and capacity (INV-03). */
export interface TechnicianCapacity {
  assignable(technicianUserId: string): Promise<{ readonly cityId: string; readonly capacity: number } | null>;
}

/** workforce (read-only, Gate 6): does the technician hold a verified repair skill (02 §4 Q-A, 06 §3 same-visit guard)? */
export interface RepairSkills {
  repairQualified(technicianUserId: string, serviceTypeId: string, specializationId: string | null, at: Date): Promise<boolean>;
}

/** geo: distance check for wait evidence (location snapshot near the locality). */
export interface LocalityDistance {
  metresFromLocality(localityId: string, point: { lat: number; lng: number }): Promise<number | null>;
}

/** A material line of an approved quote version (what the repair order carries and the completion reports on). */
export interface QuotedMaterial {
  readonly quoteItemId: string;
  readonly materialId: string;
  readonly qtyMilli: number;
  readonly unitPricePaise: number;
}

/** The facts of an approved quote version that jobs needs (Gate 6): read before the jobs transaction, never inside it. */
export interface ApprovedQuoteFacts {
  readonly quoteId: string;
  readonly quoteVersionId: string;
  readonly versionNo: number;
  readonly jobId: string;
  readonly status: string;
  readonly rateCardId: string;
  readonly totalPayablePaise: number;
  readonly presentedAt: Date;
  readonly decidedAt: Date | null;
  readonly repairPreference: 'SAME_VISIT' | 'SAME_TECHNICIAN' | 'RECOMMENDED_SPECIALIST' | null;
  readonly preferredTechnicianUserId: string | null;
  readonly allowFallback: boolean;
  readonly preferredWindow: { readonly start: Date; readonly end: Date } | null;
  readonly requiredServiceTypeId: string;
  readonly requiredSpecializationId: string | null;
  readonly materials: readonly QuotedMaterial[];
  readonly materialAvailableNow: boolean;
  /** The visit and technician of the diagnosis the version was presented from (same-visit attach, same technician). */
  readonly diagnosingVisitId: string;
  readonly diagnosingTechnicianUserId: string;
}

/** diagnosis (read-only, Gate 6): quote and diagnosis facts for repair orders, checkout and completion. */
export interface RepairQuotes {
  /** The facts of a quote version (any status; null if unknown). */
  versionFacts(quoteVersionId: string): Promise<ApprovedQuoteFacts | null>;
  /** Checkout guard facts for a diagnosis visit (06 §3): a submitted diagnosis, and a presented quote or no repair needed. */
  diagnosisCheckout(visitId: string): Promise<{ readonly submitted: boolean; readonly quotePresented: boolean; readonly noRepairNeeded: boolean }>;
}
