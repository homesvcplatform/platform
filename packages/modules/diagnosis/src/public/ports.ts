// Ports of the diagnosis module (ADR-022 / ADR-027). Facade reads of its allowed dependencies (jobs, catalog, pricing)
// are typed here structurally; workforce, identity, comms and voice are NOT allowed dependencies (modules.json), so the
// technician-skill read, the quote-approval OTP (ADR-027 #13), link delivery and call evidence (ADR-027 #3) are ports the
// apps wire. Nothing here joins a diagnosis transaction except the TCP-2 implementation this module provides to jobs.
import type { DiagnosisVisitFacts, QuoteJobFacts } from '@hsp/module-jobs';
import type { QuotePriceRequest, QuotePriceResult } from '@hsp/module-pricing';

/** jobs facade reads (diagnosis depends on jobs). */
export interface JobsReads {
  diagnosisVisitFacts(visitId: string): Promise<DiagnosisVisitFacts | null>;
  quoteJobFacts(jobId: string): Promise<QuoteJobFacts | null>;
}

/** catalog facade reads (diagnosis depends on catalog). */
export interface CatalogReads {
  problemCodes(serviceTypeId: string): Promise<readonly string[]>;
  getRepairItemsByIds(ids: readonly string[]): Promise<readonly { id: string; code: string; serviceTypeId: string; requiredServiceTypeId: string;
    requiredSpecializationId: string | null }[]>;
  getMaterialsByIds(ids: readonly string[]): Promise<readonly { id: string; code: string; unit: string }[]>;
  getMaterialReference(materialId: string, cityId: string, at?: Date): Promise<{ unitPricePaise: bigint; unit: string } | null>;
  getServiceRules(serviceTypeId: string, cityId: string, at?: Date): Promise<{ readonly same_visit_repair_allowed?: boolean | undefined;
    readonly quote_expiry_hours?: number | undefined } | null>;
}

/** pricing facade (diagnosis depends on pricing): the quote engine and snapshot reads. */
export interface QuotePricing {
  priceQuote(req: QuotePriceRequest, opts: { persist: boolean }): Promise<QuotePriceResult>;
  snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null>;
  snapshotRateCardId(snapshotId: string): Promise<string | null>;
}

/** workforce (port): the diagnosing technician's verified repair skill (02 §4 Q-A). */
export interface TechnicianSkills {
  repairQualified(technicianUserId: string, serviceTypeId: string, specializationId: string | null, at: Date): Promise<boolean>;
}

/** identity (port, ADR-027 #13): the QUOTE_LINK_APPROVAL code, always to the job customer's REGISTERED number (SR-05). */
export interface CustomerOtp {
  requestQuoteApprovalOtp(customerUserId: string, meta: { requestId: string; clientIp: string }): Promise<{ challengeId: string; expiresInSec: number }>;
  verifyQuoteApprovalOtp(customerUserId: string, input: { challengeId: string; code: string }, meta: { requestId: string; clientIp: string }): Promise<boolean>;
}

/**
 * comms (port): delivers the signed approval link to the customer (SMS / WhatsApp, Gate 8+). The token is passed once,
 * never stored in clear or logged; a fake records it in local / CI.
 */
export interface QuoteLinkSender {
  deliver(input: { customerUserId: string; quoteVersionId: string; token: string; expiresAt: Date }): Promise<void>;
}

/**
 * voice (port, ADR-027 #3): evidence of a bridged ops-desk call with the visit's technician (call_sessions, Gate 10).
 * Until telephony exists the apps wire a fake in local / CI; ops capture is refused in every other environment.
 */
export interface CallEvidence {
  bridgedCall(callSessionId: string, input: { visitId: string; technicianUserId: string }): Promise<boolean>;
  /** The ops-recorded approval call with the job's customer (registered number; recording subject to D-15). */
  recordedCustomerCall(callSessionId: string, input: { jobId: string; customerUserId: string }): Promise<boolean>;
}
