// Gate 5 fee rules (ADR-026 #1, Phase 1 06 §10): parameters of the CANCELLATION, NO_SHOW, WAITING and
// TRAVEL_COMPENSATION fee rules on a rate card, and the pure fee arithmetic. Values come from fixture rate cards
// (NOT FINAL); unknown keys are refused so a typo can't silently change a fee.
import { z } from 'zod';

const paise = z.int().min(0).max(10_000_000);
const bps = z.int().min(0).max(10_000);
const fixture = z.literal('NOT_FINAL').optional();

export const cancellationParams = z.strictObject({
  free_cancel_lead_minutes: z.int().min(0).max(24 * 60),
  late_cancel_paise: paise,
  en_route_paise: paise,
  technician_share_bps: bps,
  fixture,
});
export const noShowParams = z.strictObject({ customer_fee_paise: paise, technician_compensation_paise: paise, fixture });
export const waitingParams = z.strictObject({
  grace_minutes: z.int().min(0).max(240), per_minute_paise: paise, cap_paise: paise, technician_share_bps: bps, fixture,
});
export const travelCompensationParams = z.strictObject({ amount_paise: paise, fixture });

export type CancellationParams = z.infer<typeof cancellationParams>;
export type NoShowParams = z.infer<typeof noShowParams>;
export type WaitingParams = z.infer<typeof waitingParams>;
export type TravelCompensationParams = z.infer<typeof travelCompensationParams>;

export interface LifecycleFeeRules {
  readonly rateCardId: string;
  readonly cancellation: CancellationParams;
  readonly noShow: NoShowParams;
  readonly waiting: WaitingParams;
  readonly travelCompensation: TravelCompensationParams;
}

export type CancellationStage = 'BEFORE_ASSIGNMENT' | 'ASSIGNED_FREE' | 'ASSIGNED_LATE' | 'EN_ROUTE';

export interface FeeOutcome {
  readonly customerFeePaise: number;
  readonly technicianCompensationPaise: number;
}

/** 06 §10: free before assignment and before the free-cancel lead; a late fee after it; a fee tier + travel compensation en route. */
export function cancellationFee(stage: CancellationStage, r: LifecycleFeeRules): FeeOutcome {
  switch (stage) {
    case 'BEFORE_ASSIGNMENT':
    case 'ASSIGNED_FREE':
      return { customerFeePaise: 0, technicianCompensationPaise: 0 };
    case 'ASSIGNED_LATE':
      return { customerFeePaise: r.cancellation.late_cancel_paise,
        technicianCompensationPaise: Math.floor((r.cancellation.late_cancel_paise * r.cancellation.technician_share_bps) / 10_000) };
    case 'EN_ROUTE':
      return { customerFeePaise: r.cancellation.en_route_paise, technicianCompensationPaise: r.travelCompensation.amount_paise };
  }
}

export function noShowFee(r: LifecycleFeeRules): FeeOutcome {
  return { customerFeePaise: r.noShow.customer_fee_paise, technicianCompensationPaise: r.noShow.technician_compensation_paise };
}

/** Waiting beyond the grace, per minute, capped (06 §10 "customer late"). */
export function waitingFee(waitedMinutes: number, r: LifecycleFeeRules): FeeOutcome & { billableMinutes: number } {
  const billableMinutes = Math.max(0, Math.floor(waitedMinutes) - r.waiting.grace_minutes);
  const fee = Math.min(r.waiting.cap_paise, billableMinutes * r.waiting.per_minute_paise);
  return { billableMinutes, customerFeePaise: fee, technicianCompensationPaise: Math.floor((fee * r.waiting.technician_share_bps) / 10_000) };
}
