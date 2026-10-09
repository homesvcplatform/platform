// Public facade of module "pricing". The ONLY entry other modules and apps may import (B1).
// Gate 5 (ADR-026 #1): minimal read-only interface over fixture rate cards (NOT FINAL): visit fee + snapshot, lifecycle
// fee rules (cancellation, no-show, waiting, travel compensation). The quote engine arrives with Gate 6.
export const moduleName = 'pricing' as const;
export const schemaName = 'pricing' as const;
export { PRICING_ENGINE_VERSION, PricingService } from '../application/service.ts';
export type { PricingDeps } from '../application/service.ts';
export {
  cancellationFee, cancellationParams, noShowFee, noShowParams, travelCompensationParams, waitingFee, waitingParams,
} from '../domain/fees.ts';
export type { CancellationStage as FeeCancellationStage, FeeOutcome, LifecycleFeeRules } from '../domain/fees.ts';
/** Every pricing SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as PRICING_SQL } from '../infrastructure/sql.ts';
