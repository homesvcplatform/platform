// Gate 5 (ADR-026 #1): lifecycle fee parameters and arithmetic (06 §10); SQL ownership (B2).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';
import { cancellationFee, cancellationParams, noShowFee, PRICING_SQL, waitingFee, type LifecycleFeeRules } from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));
const rules: LifecycleFeeRules = {
  rateCardId: 'card',
  cancellation: { free_cancel_lead_minutes: 120, late_cancel_paise: 4900, en_route_paise: 9900, technician_share_bps: 7500 },
  noShow: { customer_fee_paise: 9900, technician_compensation_paise: 7500 },
  waiting: { grace_minutes: 10, per_minute_paise: 200, cap_paise: 6000, technician_share_bps: 7500 },
  travelCompensation: { amount_paise: 5000 },
};

describe('lifecycle fees (06 §10, fixture values)', () => {
  it('cancellation: free before assignment and before the lead; late fee with a share; en route fee with travel compensation', () => {
    expect(cancellationFee('BEFORE_ASSIGNMENT', rules)).toEqual({ customerFeePaise: 0, technicianCompensationPaise: 0 });
    expect(cancellationFee('ASSIGNED_FREE', rules)).toEqual({ customerFeePaise: 0, technicianCompensationPaise: 0 });
    expect(cancellationFee('ASSIGNED_LATE', rules)).toEqual({ customerFeePaise: 4900, technicianCompensationPaise: 3675 });
    expect(cancellationFee('EN_ROUTE', rules)).toEqual({ customerFeePaise: 9900, technicianCompensationPaise: 5000 });
  });

  it('no-show and waiting (grace, per minute, cap)', () => {
    expect(noShowFee(rules)).toEqual({ customerFeePaise: 9900, technicianCompensationPaise: 7500 });
    expect(waitingFee(8, rules)).toEqual({ billableMinutes: 0, customerFeePaise: 0, technicianCompensationPaise: 0 });
    expect(waitingFee(25, rules)).toEqual({ billableMinutes: 15, customerFeePaise: 3000, technicianCompensationPaise: 2250 });
    expect(waitingFee(500, rules).customerFeePaise).toBe(6000);
  });

  it('parameters are strict (a typo or negative value is refused)', () => {
    expect(cancellationParams.safeParse({ ...rules.cancellation, fixture: 'NOT_FINAL' }).success).toBe(true);
    expect(cancellationParams.safeParse({ ...rules.cancellation, late_cancel_paise: -1 }).success).toBe(false);
    expect(cancellationParams.safeParse({ ...rules.cancellation, en_route_pasie: 1 }).success).toBe(false);
  });
});

describe('B2: pricing SQL touches only its own schema', () => {
  it('every statement', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(PRICING_SQL)) expect(() => assertModuleOwnsSql('pricing', sql, ownership), name).not.toThrow();
  });
});
