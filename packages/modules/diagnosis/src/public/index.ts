// Public facade of module "diagnosis". The ONLY entry other modules and apps may import (B1).
// Gate 6 (ADR-027): diagnosis drafts / submission (technician app; ops-desk capture local / test only), server-side quote
// pricing with immutable, hash-bound versions, customer decisions (session, signed link + OTP; ops-recorded channel
// off), change orders, expiry; the TCP-2 material-usage recorder and the quote facts it provides to jobs.
export const moduleName = 'diagnosis' as const;
export const schemaName = 'diagnosis' as const;
export { DIAGNOSIS_TIMER_TASKS, DiagnosisService } from '../application/service.ts';
export type { DecisionInput, DiagnosisDeps, DraftContent, DraftLine, RequestMeta } from '../application/service.ts';
export type { CallEvidence, CatalogReads, CustomerOtp, JobsReads, QuoteLinkSender, QuotePricing, TechnicianSkills } from './ports.ts';
export { registerDiagnosisPolicies } from '../domain/policies.ts';
export type { DiagnosisAssigneeResource, DiagnosisCityResource, QuoteOwnerResource } from '../domain/policies.ts';
export {
  canMove, canonicalJson, DIAGNOSIS_TRANSITIONS, FIXTURE_DIAGNOSIS_POLICY, isLinkPreviewAgent, linkTokenHash, newLinkToken, quoteContentHash,
  QUOTE_VERSION_TRANSITIONS, repairOptions,
} from '../domain/rules.ts';
export type { DiagnosisPolicy, HashedLine, HashedTotals, RepairOption, RepairOptionFacts } from '../domain/rules.ts';
/** Every diagnosis SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as DIAGNOSIS_SQL } from '../infrastructure/sql.ts';
