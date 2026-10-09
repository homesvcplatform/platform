// Gate 6 exit criterion "margin-warning hook from the simulator formulas on rate-card activation" (ADR-027 #12): the pure
// formulas reproduce the scenario tables of Phase 1.1 06 §2 for Models A, B and C at the baseline assumptions, and the
// hook flags every scenario with a negative contribution margin. Analysis only; NOT FINAL values.
import { describe, expect, it } from 'vitest';
import { BASELINE_ASSUMPTIONS_NOT_FINAL, pricingModelFromCard, rateCardMarginWarnings, simulateScenarios, type PricingModel } from '../public/index.ts';

const MODEL_A: PricingModel = { visitFee: 149, visitFeeCredit: 1, platformFee: 0, diagnosisPayout: 100 };
const MODEL_B: PricingModel = { visitFee: 99, visitFeeCredit: 0, platformFee: 0, diagnosisPayout: 70 };
const MODEL_C: PricingModel = { visitFee: 149, visitFeeCredit: 0.5, platformFee: 29, diagnosisPayout: 100 };

/** 06 §2 tables: [customer pays, platform commission, other variable, contribution margin] per scenario S1..S7. */
const TABLES: Record<'A' | 'B' | 'C', [number, number, number, number][]> = {
  A: [[650, 30, 52.7, -37.6], [650, 30, 57.8, -42.7], [650, -20, 57.8, -92.7], [149, 49, 32.7, 14.8], [59.4, -0.6, 19.5, -20.7], [-50, -50, 15.1, -64.6], [0, -150, 26.7, -176.7]],
  B: [[749, 144, 56.7, 71.5], [749, 144, 61.8, 66.4], [749, 109, 61.8, 31.4], [99, 29, 30.7, -2.7], [59.4, -0.6, 19.5, -20.7], [-50, -50, 15.1, -64.6], [0, -150, 26.7, -176.7]],
  C: [[753.5, 133.5, 56.8, 60.8], [753.5, 133.5, 61.9, 55.7], [753.5, 83.5, 61.9, 5.7], [149, 49, 32.7, 14.8], [59.4, -0.6, 19.5, -20.7], [-50, -50, 15.1, -64.6], [0, -150, 26.7, -176.7]],
};

/** The tables print one decimal; the exact values are within half a display step (14.85 is printed 14.8 there). */
const near = (actual: number, printed: number) => Math.abs(actual - printed) <= 0.05 + 1e-9;

describe('pricing simulator (1.1/06 §1.2 formulas)', () => {
  it.each([['A', MODEL_A], ['B', MODEL_B], ['C', MODEL_C]] as const)('Model %s reproduces the §2 table', (name, model) => {
    const rows = simulateScenarios(model);
    expect(rows).toHaveLength(7);
    rows.forEach((r, i) => {
      const [pays, commission, other, cm] = TABLES[name][i] as [number, number, number, number];
      expect(near(r.customerPays, pays), `${name} ${r.scenario} pays ${r.customerPays}`).toBe(true);
      expect(near(r.platformCommission, commission), `${name} ${r.scenario} commission ${r.platformCommission}`).toBe(true);
      expect(near(r.otherVariable, other), `${name} ${r.scenario} other ${r.otherVariable}`).toBe(true);
      expect(near(r.contributionMargin, cm), `${name} ${r.scenario} CM ${r.contributionMargin}`).toBe(true);
    });
  });

  it('the hook flags exactly the negative scenarios; S1–S4 decide whether the model itself is loss-making', () => {
    expect(rateCardMarginWarnings(MODEL_A).modelDependent.map((w) => w.scenario)).toEqual(['S1_SAME_TECH_SAME_VISIT', 'S2_SAME_TECH_LATER', 'S3_DIFFERENT_TECHNICIANS']);
    expect(rateCardMarginWarnings(MODEL_B).modelDependent.map((w) => w.scenario)).toEqual(['S4_DIAGNOSIS_ONLY']);
    expect(rateCardMarginWarnings(MODEL_C).modelDependent).toEqual([]);
    for (const m of [MODEL_A, MODEL_B, MODEL_C]) {
      expect(rateCardMarginWarnings(m).warnings.map((w) => w.scenario)).toEqual(expect.arrayContaining(['S5_CANCEL_AFTER_TRAVEL', 'S6_TECH_NO_SHOW', 'S7_WARRANTY_REVISIT']));
    }
  });

  it('assumptions drive the result (e.g. 18 % platform-borne tax makes every model negative, 06 §2.1)', () => {
    const taxed = { ...BASELINE_ASSUMPTIONS_NOT_FINAL, platformTax: 0.18 };
    for (const m of [MODEL_B, MODEL_C]) {
      const s1 = simulateScenarios(m, taxed)[0];
      expect(s1?.tax).toBeGreaterThan(0);
      expect(s1?.contributionMargin).toBeLessThan(simulateScenarios(m)[0]?.contributionMargin ?? 0);
    }
  });

  it('maps rate-card values (paise, bps) to the simulator model', () => {
    expect(pricingModelFromCard({ visitFeePaise: 14_900, visitFeeCreditBps: 5000, platformFeePaise: 2900, diagnosisPayoutPaise: 10_000 })).toEqual(MODEL_C);
  });
});
