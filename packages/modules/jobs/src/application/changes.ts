// Ops presence overrides (INV-14 / INV-15, 06 §3, ADR-026 #7, ADR-027 #5) as two-person approved change requests
// (ADR-025 #5): dispatch proposes (`dispatch.override_presence`), a city manager approves (`presence_override.approve`)
// with the bound passkey step-up, after the customer confirmed the technician's arrival / the completed work on a call to
// their registered number. The approved payload is executed once by jobs (audited OPS_OVERRIDE_* proof referencing the
// change request). Like every configuration approval these wait for the independent WebAuthn review outside local / CI.
import { z } from 'zod';
import { AppError } from '@hsp/errors';
import type { JobsService } from './service.ts';

const reason = z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/);

const input = z.strictObject({
  visitId: z.uuid(),
  reasonCode: reason,
  customerConfirmedByCall: z.literal(true),
});

function invalid(issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]): AppError {
  return new AppError('VALIDATION_FAILED', { fields: issues.slice(0, 10).map((i) => ({ path: `change.${i.path.map(String).join('.')}`, code: i.code.toUpperCase() })) });
}

export function arrivalOverrideChangeAction(jobs: JobsService) {
  return {
    actionType: 'jobs.visit.arrival_override',
    resourceType: 'jobs.visit',
    makerPermission: 'dispatch.override_presence',
    checkerPermission: 'presence_override.approve',
    riskLevel: 'HIGH' as const,

    async prepare(raw: unknown) {
      const r = input.safeParse(raw);
      if (!r.success) throw invalid(r.error.issues);
      const target = await jobs.arrivalOverrideTarget(r.data.visitId);
      if (!target) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'change.visitId', code: 'NOT_AWAITING_ARRIVAL' }] });
      const payload = { visitId: r.data.visitId, reasonCode: r.data.reasonCode, cityId: target.cityId };
      return { payload, resourceId: r.data.visitId, cityId: target.cityId, summary: { visitId: r.data.visitId, reasonCode: r.data.reasonCode } };
    },

    cityOf(payload: Readonly<Record<string, unknown>>): string | null {
      return typeof payload['cityId'] === 'string' ? payload['cityId'] : null;
    },

    async execute(changeRequestId: string, payload: Readonly<Record<string, unknown>>, ctx: { now: Date; actorId: string; requestId: string }) {
      await jobs.executeArrivalOverride(changeRequestId, { visitId: payload['visitId'] as string, reasonCode: payload['reasonCode'] as string },
        { actorId: ctx.actorId, requestId: ctx.requestId });
    },
  };
}

const completion = z.strictObject({
  visitId: z.uuid(),
  reasonCode: reason,
  customerConfirmedByCall: z.literal(true),
  outcome: z.enum(['COMPLETE', 'PARTIAL']),
  partialReasonCode: reason.optional(),
  materialUsage: z.array(z.strictObject({ quoteItemId: z.uuid(), qtyUsed: z.number().min(0).max(1000), actualUnitCostPaise: z.int().min(0).max(10_000_000).optional() }))
    .max(50),
});

/** Gate 6 (06 §3, INV-15): the ops completion override of a repair visit (the customer has no code / the code locked). */
export function completionOverrideChangeAction(jobs: JobsService) {
  return {
    actionType: 'jobs.visit.completion_override',
    resourceType: 'jobs.visit',
    makerPermission: 'dispatch.override_presence',
    checkerPermission: 'presence_override.approve',
    riskLevel: 'HIGH' as const,

    async prepare(raw: unknown) {
      const r = completion.safeParse(raw);
      if (!r.success) throw invalid(r.error.issues);
      const target = await jobs.completionOverrideTarget(r.data.visitId);
      if (!target) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'change.visitId', code: 'NOT_A_REPAIR_IN_PROGRESS' }] });
      const payload = { visitId: r.data.visitId, reasonCode: r.data.reasonCode, cityId: target.cityId, outcome: r.data.outcome,
        partialReasonCode: r.data.partialReasonCode ?? null, materialUsage: r.data.materialUsage };
      return { payload, resourceId: r.data.visitId, cityId: target.cityId,
        summary: { visitId: r.data.visitId, reasonCode: r.data.reasonCode, outcome: r.data.outcome } };
    },

    cityOf(payload: Readonly<Record<string, unknown>>): string | null {
      return typeof payload['cityId'] === 'string' ? payload['cityId'] : null;
    },

    async execute(changeRequestId: string, payload: Readonly<Record<string, unknown>>, ctx: { now: Date; actorId: string; requestId: string }) {
      const usage = payload['materialUsage'] as { quoteItemId: string; qtyUsed: number; actualUnitCostPaise?: number }[];
      await jobs.executeCompletionOverride(changeRequestId, {
        visitId: payload['visitId'] as string, reasonCode: payload['reasonCode'] as string, outcome: payload['outcome'] as 'COMPLETE' | 'PARTIAL',
        partialReasonCode: (payload['partialReasonCode'] as string | null) ?? undefined, materialUsage: usage,
      }, { actorId: ctx.actorId, requestId: ctx.requestId });
    },
  };
}
