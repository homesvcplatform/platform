// Ops presence override (INV-14, 06 §3, ADR-026 #7) as a two-person approved change request (ADR-025 #5): dispatch
// proposes (`dispatch.override_presence`), a city manager approves (`presence_override.approve`) with the bound passkey
// step-up, after the customer confirmed the technician's arrival on a call to their registered number. The approved
// payload is executed once by jobs (audited OPS_OVERRIDE_ARRIVAL proof referencing the change request).
import { z } from 'zod';
import { AppError } from '@hsp/errors';
import type { JobsService } from './service.ts';

const input = z.strictObject({
  visitId: z.uuid(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/),
  customerConfirmedByCall: z.literal(true),
});

export function arrivalOverrideChangeAction(jobs: JobsService) {
  return {
    actionType: 'jobs.visit.arrival_override',
    resourceType: 'jobs.visit',
    makerPermission: 'dispatch.override_presence',
    checkerPermission: 'presence_override.approve',
    riskLevel: 'HIGH' as const,

    async prepare(raw: unknown) {
      const r = input.safeParse(raw);
      if (!r.success) {
        throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: `change.${i.path.join('.')}`, code: i.code.toUpperCase() })) });
      }
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
