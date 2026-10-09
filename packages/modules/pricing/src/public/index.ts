// Public facade of module "pricing". The ONLY entry other modules and apps may import (B1).
// Gate 5 (ADR-026 #1): minimal read-only interface over fixture rate cards (NOT FINAL): visit fee + snapshot, lifecycle
// fee rules (cancellation, no-show, waiting, travel compensation). Gate 6 (ADR-027): the quote engine (server-side
// pricing, immutable snapshots) and the pricing-simulator margin-warning hook.
export const moduleName = 'pricing' as const;
export const schemaName = 'pricing' as const;
export { FIXTURE_QUOTE_PRICING_POLICY, PRICING_ENGINE_VERSION, PricingService, QUOTE_ENGINE_VERSION } from '../application/service.ts';
export type { PricingDeps, QuotePriceRequest, QuotePriceResult } from '../application/service.ts';
export {
  cancellationFee, cancellationParams, noShowFee, noShowParams, travelCompensationParams, waitingFee, waitingParams,
} from '../domain/fees.ts';
export type { CancellationStage as FeeCancellationStage, FeeOutcome, LifecycleFeeRules } from '../domain/fees.ts';
export {
  CREDIT_TYPES, materialMarkupParams, platformFeeParams, priceQuote, signedTotal, visitFeeCreditParams,
} from '../domain/quote.ts';
export type {
  PricedLine, PricedQuote, QuoteItemType, QuoteLineInput, QuotePricingFailure, QuotePricingPolicy, QuotePricingResult, QuoteRateCard, QuoteTotals,
  RateCardRepairItem,
} from '../domain/quote.ts';
export { BASELINE_ASSUMPTIONS_NOT_FINAL, pricingModelFromCard, rateCardMarginWarnings, simulateScenarios } from '../domain/margin.ts';
export type { MarginWarning, PricingModel, ScenarioId, ScenarioResult, SimulatorAssumptions } from '../domain/margin.ts';
/** Every pricing SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as PRICING_SQL } from '../infrastructure/sql.ts';
