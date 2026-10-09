// Phase 1 04 §10 (diagnosis) and §11 (quotes & approval), Gate 6 subset (ADR-027). Requests are strict: unknown fields
// are rejected. The client sends item references and quantities, never prices (06 §7); a material may carry a proposed
// price (checked against the city reference) and custom labour a proposed price (checked against the band, D9).
// Omitted until their gates: free-text notes (need a platform data-class key), photos / voice notes (files, Gate 8),
// warranty assessments (warranty gate), IVR approval (Gate 10).
import { z } from 'zod';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/);
const quantity = z.number().positive().max(1000);
const paise = z.int().min(0).max(10_000_000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
/** SR-05: 256-bit link token, base64url without padding; travels in the URL fragment and the request body only. */
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const datetime = z.iso.datetime({ offset: true });
const window = z.strictObject({ start: datetime, end: datetime });
const repairPreference = z.enum(['SAME_VISIT', 'SAME_TECHNICIAN', 'RECOMMENDED_SPECIALIST']);
const rejectReason = z.enum(['TOO_EXPENSIVE', 'WILL_DO_LATER', 'SECOND_OPINION', 'NOT_NEEDED', 'OTHER']);

export const startDiagnosis = z.strictObject({ kind: z.enum(['INITIAL', 'ADDITIONAL_FINDING']) });

export const diagnosisLine = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('REPAIR_ITEM'), repairItemId: z.uuid(), qty: quantity }),
  z.strictObject({ type: z.literal('MATERIAL'), materialId: z.uuid(), qty: quantity, proposedUnitPricePaise: paise.optional(), reasonCode: reason.optional() }),
  z.strictObject({ type: z.literal('CUSTOM_LABOUR'), qty: quantity, proposedUnitPricePaise: paise, reasonCode: reason }),
]);

export const diagnosisDraft = z.strictObject({
  expectedVersion: z.int().min(0),
  problemCode: code,
  observedChips: z.array(code).max(10).default([]),
  severity: z.enum(['MINOR', 'MODERATE', 'MAJOR', 'SAFETY_HAZARD']),
  safetyAdviceCode: code.nullable().default(null),
  items: z.array(diagnosisLine).max(20),
  noRepairNeeded: z.boolean(),
  sameVisitFeasible: z.boolean(),
  materialAvailableNow: z.boolean(),
});

/** previewHash: the content hash of the preview the technician showed (required when a quote is created). */
export const submitDiagnosis = z.strictObject({ expectedVersion: z.int().min(0), previewHash: hash.optional() });

export const approveQuote = z.strictObject({
  contentHash: hash,
  repairPreference,
  allowFallback: z.boolean(),
  preferredWindow: window.optional(),
});
export const rejectQuote = z.strictObject({ contentHash: hash, reasonCode: rejectReason });

export const linkView = z.strictObject({ token: linkToken });
export const linkOtp = z.strictObject({ token: linkToken });
export const linkDecision = z.strictObject({
  token: linkToken,
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  decision: z.enum(['APPROVE', 'REJECT']),
  contentHash: hash,
  repairPreference: repairPreference.optional(),
  allowFallback: z.boolean().optional(),
  preferredWindow: window.optional(),
  reasonCode: rejectReason.optional(),
});

/** Ops-desk capture (ADR-027 #3): on a bridged call with the technician; local / test only until telephony (Gate 10). */
export const opsStartDiagnosis = startDiagnosis.extend({ callSessionId: z.uuid() });
