// Phase 1 04 §7 and §10 (Gate 5 subset): booking, job reads and cancellation (customer), visit actions (technician),
// ops-assisted booking, manual assignment and confirmations (admin). Requests are strict: unknown fields are rejected.
// Gate 5 omissions, added with the gates that own them: problem text / voice note / photos (files, Gate 8), onsite
// contact, preferred language; diagnosis, quotes and completion (Gate 6).
import { z } from 'zod';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/);

export const booking = z.strictObject({
  clientRequestId: z.uuid(),
  serviceTypeId: z.uuid(),
  symptomCodes: z.array(code).min(1).max(5),
  addressId: z.uuid(),
  timing: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ASAP') }),
    z.strictObject({ type: z.literal('SLOT'), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }),
  ]),
  acceptedVisitFeePaise: z.int().min(0).max(10_000_000),
  confirmSeparate: z.boolean().default(false),
  paymentPreference: z.enum(['ONLINE', 'CASH', 'EITHER']),
  /** X-34: an adult must be present; required. */
  onsiteAdult: z.enum(['SELF', 'ADULT_FAMILY', 'OTHER_ADULT']),
});

export const assistedBooking = booking.extend({ customerUserId: z.uuid() });

export const cancel = z.strictObject({
  reasonCode: z.enum(['CHANGED_MIND', 'BOOKED_BY_MISTAKE', 'FOUND_ANOTHER_SOLUTION', 'TIMING_NOT_SUITABLE', 'OTHER']),
  acceptedFeePaise: z.int().min(0).max(10_000_000),
});

export const depart = z.strictObject({ clientReportedAt: z.iso.datetime({ offset: true }) });
export const arrive = z.strictObject({ startCode: z.string().regex(/^\d{4}$/), clientReportedAt: z.iso.datetime({ offset: true }) });
export const waitStart = z.strictObject({
  location: z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(5_000) }),
});
export const release = z.strictObject({ reasonCode: reason, safetyConcern: z.boolean().optional() });

export const manualAssignment = z.strictObject({ technicianUserId: z.uuid(), reasonCode: reason });
export const customerConfirmation = z.strictObject({ reasonCode: z.literal('REGISTERED_NUMBER_CALL') });
export const opsWait = z.strictObject({ reasonCode: reason });

// Gate 6 (04 §10 / §12, ADR-027): diagnosis checkout, repair completion, materials confirmation, repair scheduling and
// cancellation. No photos or receipts until the files module exists (ADR-027 #2).
const quantity = z.number().min(0).max(1000);

export const checkout = z.strictObject({});
export const completeRepair = z.strictObject({
  completionCode: z.string().regex(/^\d{4}$/),
  outcome: z.enum(['COMPLETE', 'PARTIAL']),
  partialReasonCode: reason.optional(),
  materialUsage: z.array(z.strictObject({ quoteItemId: z.uuid(), qtyUsed: quantity, actualUnitCostPaise: z.int().min(0).max(10_000_000).optional() })).max(50),
});
export const materialsConfirmed = z.strictObject({ items: z.array(z.strictObject({ quoteItemId: z.uuid(), have: z.boolean() })).max(50) });
export const scheduleRepair = z.strictObject({
  timing: booking.shape.timing,
  performerPreference: z.enum(['SAME_TECHNICIAN', 'RECOMMENDED_SPECIALIST']).optional(),
  allowFallback: z.boolean().optional(),
});
export const cancelRepair = z.strictObject({
  reasonCode: z.enum(['CHANGED_MIND', 'FOUND_ANOTHER_SOLUTION', 'TIMING_NOT_SUITABLE', 'TOO_EXPENSIVE', 'OTHER']),
  acceptedFeePaise: z.int().min(0).max(10_000_000),
});
