// Pricing simulator (Phase 1.1 06 §1–§2, ADR-027 #12): the per-scenario contribution-margin formulas, as pure functions,
// and the margin-warning hook for a rate card before its maker-checker activation (01 §4.2 pricing: "must flag any rate
// card whose scenario CM is negative"). Analysis only: amounts are rupees as decimals, never money movement. The hook
// warns; it never blocks (the decision stays with the approvers). No activation workflow is built in Gate 6.

/** Simulator inputs (06 §1.1). Baseline values are illustrative, NOT FINAL, and need pilot data. */
export interface SimulatorAssumptions {
  readonly labour: number;                 // L
  readonly material: number;               // M
  readonly materialMarkup: number;         // mk (fraction)
  readonly technicianShare: number;        // s (fraction of labour)
  readonly sameTechDiagnosisShare: number; // p (D-06 PARTIAL)
  readonly onlineShare: number;            // on
  readonly paFee: number;                  // pa
  readonly telephonyApp: number;           // t_app
  readonly telephonyBasic: number;         // t_basic
  readonly basicPhoneShare: number;        // bp
  readonly messaging: number;              // msg
  readonly support: number;                // sup
  readonly diagnosisDesk: number;          // desk
  readonly cancellationFee: number;        // F
  readonly cancellationCollected: number;  // q
  readonly travelCompensation: number;     // Ct
  readonly noShowGoodwill: number;         // G
  readonly refundRate: number;             // r
  readonly fraudRate: number;              // f
  readonly warrantyClaimRate: number;      // w
  readonly warrantyPayout: number;         // Pw
  readonly platformTax: number;            // τ (⚖️ placeholder)
}

/** The pricing model a rate card expresses (06 §1.3). */
export interface PricingModel {
  readonly visitFee: number;          // D
  readonly visitFeeCredit: number;    // c (fraction)
  readonly platformFee: number;       // pf
  readonly diagnosisPayout: number;   // Pd
}

export const BASELINE_ASSUMPTIONS_NOT_FINAL: SimulatorAssumptions = Object.freeze({
  labour: 400, material: 250, materialMarkup: 0, technicianShare: 0.8, sameTechDiagnosisShare: 0.5, onlineShare: 0.5, paFee: 0.02,
  telephonyApp: 2, telephonyBasic: 6, basicPhoneShare: 0.4, messaging: 1.5, support: 12, diagnosisDesk: 24, cancellationFee: 99,
  cancellationCollected: 0.6, travelCompensation: 60, noShowGoodwill: 50, refundRate: 0.03, fraudRate: 0.01, warrantyClaimRate: 0.05,
  warrantyPayout: 150, platformTax: 0,
});

export type ScenarioId = 'S1_SAME_TECH_SAME_VISIT' | 'S2_SAME_TECH_LATER' | 'S3_DIFFERENT_TECHNICIANS' | 'S4_DIAGNOSIS_ONLY'
  | 'S5_CANCEL_AFTER_TRAVEL' | 'S6_TECH_NO_SHOW' | 'S7_WARRANTY_REVISIT';

export interface ScenarioResult {
  readonly scenario: ScenarioId;
  readonly customerPays: number;
  readonly diagnosisPayout: number;
  readonly repairPayout: number;
  readonly materialCost: number;
  readonly compensation: number;
  readonly platformCommission: number;
  readonly paCost: number;
  readonly otherVariable: number;
  readonly expectedWarranty: number;
  readonly tax: number;
  readonly contributionMargin: number;
}

function perVisitComms(a: SimulatorAssumptions): number {
  return a.telephonyBasic * a.basicPhoneShare + a.telephonyApp * (1 - a.basicPhoneShare) + a.messaging;
}

function result(scenario: ScenarioId, a: SimulatorAssumptions, f: { customerPays: number; diagnosisPayout: number; repairPayout: number;
  materialCost: number; compensation: number; visits: number; diagnosisHappened: boolean; warranty: boolean; taxBase: number }): ScenarioResult {
  const platformCommission = f.customerPays - f.diagnosisPayout - f.repairPayout - f.materialCost - f.compensation;
  const paCost = f.customerPays * a.onlineShare * a.paFee;
  const otherVariable = f.visits * perVisitComms(a) + a.support + (f.diagnosisHappened ? a.diagnosisDesk * a.basicPhoneShare : 0)
    + f.customerPays * (a.refundRate + a.fraudRate);
  const expectedWarranty = f.warranty ? a.warrantyClaimRate * (a.warrantyPayout + perVisitComms(a) + a.support) : 0;
  const tax = a.platformTax * f.taxBase;
  return { scenario, customerPays: f.customerPays, diagnosisPayout: f.diagnosisPayout, repairPayout: f.repairPayout, materialCost: f.materialCost,
    compensation: f.compensation, platformCommission, paCost, otherVariable, expectedWarranty, tax,
    contributionMargin: platformCommission - paCost - otherVariable - expectedWarranty - tax };
}

/** The seven scenarios of 06 §2 for one pricing model (formulas of §1.2). */
export function simulateScenarios(m: PricingModel, a: SimulatorAssumptions = BASELINE_ASSUMPTIONS_NOT_FINAL): ScenarioResult[] {
  const repairPays = m.visitFee * (1 - m.visitFeeCredit) + a.labour + a.material * (1 + a.materialMarkup) + m.platformFee;
  const repairPayout = a.technicianShare * a.labour;
  const taxBase = m.visitFee * (1 - m.visitFeeCredit) + a.labour;
  const repair = { customerPays: repairPays, repairPayout, materialCost: a.material, compensation: 0, diagnosisHappened: true, warranty: true, taxBase };
  return [
    result('S1_SAME_TECH_SAME_VISIT', a, { ...repair, diagnosisPayout: m.diagnosisPayout * a.sameTechDiagnosisShare, visits: 1 }),
    result('S2_SAME_TECH_LATER', a, { ...repair, diagnosisPayout: m.diagnosisPayout * a.sameTechDiagnosisShare, visits: 2 }),
    result('S3_DIFFERENT_TECHNICIANS', a, { ...repair, diagnosisPayout: m.diagnosisPayout, visits: 2 }),
    result('S4_DIAGNOSIS_ONLY', a, { customerPays: m.visitFee, diagnosisPayout: m.diagnosisPayout, repairPayout: 0, materialCost: 0, compensation: 0,
      visits: 1, diagnosisHappened: true, warranty: false, taxBase: m.visitFee }),
    result('S5_CANCEL_AFTER_TRAVEL', a, { customerPays: a.cancellationFee * a.cancellationCollected, diagnosisPayout: 0, repairPayout: 0, materialCost: 0,
      compensation: a.travelCompensation, visits: 1, diagnosisHappened: false, warranty: false, taxBase: 0 }),
    result('S6_TECH_NO_SHOW', a, { customerPays: -a.noShowGoodwill, diagnosisPayout: 0, repairPayout: 0, materialCost: 0, compensation: 0, visits: 1,
      diagnosisHappened: false, warranty: false, taxBase: 0 }),
    result('S7_WARRANTY_REVISIT', a, { customerPays: 0, diagnosisPayout: 0, repairPayout: a.warrantyPayout, materialCost: 0, compensation: 0, visits: 1,
      diagnosisHappened: true, warranty: false, taxBase: 0 }),
  ];
}

export interface MarginWarning {
  readonly scenario: ScenarioId;
  readonly contributionMargin: number;
}

/**
 * The margin-warning hook: run before a rate card's maker-checker activation. Returns every scenario whose contribution
 * margin is negative (06 §6). S5–S7 don't depend on the pricing model and are negative at the baseline, so a card is
 * judged on S1–S4 (`modelDependent`) while all warnings are still reported to the approvers.
 */
export function rateCardMarginWarnings(m: PricingModel, a: SimulatorAssumptions = BASELINE_ASSUMPTIONS_NOT_FINAL):
  { readonly warnings: readonly MarginWarning[]; readonly modelDependent: readonly MarginWarning[] } {
  const warnings = simulateScenarios(m, a).filter((s) => s.contributionMargin < 0)
    .map((s) => ({ scenario: s.scenario, contributionMargin: s.contributionMargin }));
  const independent = new Set<ScenarioId>(['S5_CANCEL_AFTER_TRAVEL', 'S6_TECH_NO_SHOW', 'S7_WARRANTY_REVISIT']);
  return { warnings, modelDependent: warnings.filter((w) => !independent.has(w.scenario)) };
}

/** Maps rate-card values (paise / bps) to the simulator's pricing model (rupees / fractions). */
export function pricingModelFromCard(card: { visitFeePaise: number; visitFeeCreditBps: number; platformFeePaise: number; diagnosisPayoutPaise: number }): PricingModel {
  return { visitFee: card.visitFeePaise / 100, visitFeeCredit: card.visitFeeCreditBps / 10_000, platformFee: card.platformFeePaise / 100,
    diagnosisPayout: card.diagnosisPayoutPaise / 100 };
}
