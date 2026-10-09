// Ports owned by the jobs module (ADR-022, ADR-026). Callee modules implement these; apps wire them. jobs never
// imports diagnosis, payments, workforce or customers internals, so the compile-time graph stays acyclic and B4 holds:
// only TCP-2 / TCP-3 calls run inside a jobs transaction.
import type { LifecycleFeeRules } from '@hsp/module-pricing';

/** Opaque handle to the caller's open database transaction (defined in @hsp/db at Gate 2). */
export interface TransactionContext {
  readonly transactionId: string;
}

/** TCP-2: record materials actually used in the same transaction as visit completion. */
export interface MaterialUsageRecorder {
  recordMaterialUsage(
    tx: TransactionContext,
    input: { readonly repairOrderId: string; readonly visitId: string },
  ): Promise<void>;
}

/**
 * TCP-3: issue the deterministic bill in the same transaction as the jobs command that makes money due (G-1): visit
 * completion (Gate 6 / 11), a cancellation with a fee, a customer no-show (Gate 5). The bill is a pure function of the
 * referenced immutable price snapshot. Gate 5 wires a deterministic placeholder; Gate 11 the real implementation.
 */
export interface BillIssuer {
  issueBill(
    tx: TransactionContext,
    input: { readonly jobId: string; readonly visitId: string; readonly kind: 'CANCELLATION_FEE' | 'NO_SHOW_FEE'; readonly priceSnapshotId: string },
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

/** catalog: what a city offers (ADR-025 #8). */
export interface ServiceOffer {
  isOffered(serviceTypeId: string, cityId: string, at?: Date): Promise<boolean>;
  symptomCodes(serviceTypeId: string): Promise<readonly string[]>;
}

/** pricing (read-only, ADR-026 #1). Snapshots are written in pricing's own transaction (B4). */
export interface LifecyclePricing {
  visitFee(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly amountPaise: number } | null>;
  snapshotVisitFee(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly snapshotId: string; readonly amountPaise: number } | null>;
  lifecycleFeeRules(cityId: string, at?: Date): Promise<LifecycleFeeRules | null>;
  snapshot(input: { rateCardId: string; ruleRefs: Record<string, unknown>; inputs: Record<string, unknown>; outputs: Record<string, unknown> }): Promise<string>;
}

/** workforce (read-only): an ACTIVE technician's city and capacity (INV-03). */
export interface TechnicianCapacity {
  assignable(technicianUserId: string): Promise<{ readonly cityId: string; readonly capacity: number } | null>;
}

/** geo: distance check for wait evidence (location snapshot near the locality). */
export interface LocalityDistance {
  metresFromLocality(localityId: string, point: { lat: number; lng: number }): Promise<number | null>;
}
