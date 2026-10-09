// Public facade of module "jobs". The ONLY entry other modules and apps may import (B1).
// Gate 5: job / visit / assignment / repair-order lifecycle, booking, manual assignment, technician visit actions,
// disclosure, cancellation evaluation, durable timers; TCP-1 assignment facade and TCP-2 / TCP-3 ports.
// Gate 6 (ADR-027): diagnosis checkout, repair orders from quote events (consumer), repair scheduling / cancellation,
// materials confirmation, repair completion (code or ops override) with TCP-2 usage and TCP-3 bills; facade reads for
// the diagnosis module.
export const moduleName = 'jobs' as const;
export const schemaName = 'jobs' as const;
export type {
  AddressBook, ApprovedQuoteFacts, BillIssuer, BillKind, LifecyclePricing, LocalityDistance, MaterialUsageRecorder, QuotedMaterial, RepairQuotes,
  RepairSkills, ServiceOffer, TechnicianCapacity, TransactionContext,
} from './ports.ts';
export { JobsService, TIMER_TASKS } from '../application/service.ts';
export type { BookingInput, CompletionInput, DiagnosisVisitFacts, JobsDeps, QuoteJobFacts, RequestMeta, Timing } from '../application/service.ts';
export { arrivalOverrideChangeAction, completionOverrideChangeAction } from '../application/changes.ts';
export { registerJobsPolicies } from '../domain/policies.ts';
export type { AssigneeResource, CityResource, OwnedResource } from '../domain/policies.ts';
/** Every jobs SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as JOBS_SQL } from '../infrastructure/sql.ts';
export {
  allowedTransitions, assertTransition, canTransition, CREATED, InvalidTransitionError, isTerminal, MACHINES, statesOf,
} from '../domain/transitions.ts';
export type { AssignmentStatus, JobStatus, Machine, RepairOrderStatus, VisitStatus } from '../domain/transitions.ts';
export { FIXTURE_LIFECYCLE_POLICY } from '../domain/policy.ts';
export type { LifecyclePolicy } from '../domain/policy.ts';
export { bookingWindow, cancellationStage, disclosure, isValidPublicRef, matchStartAt, newPublicRef } from '../domain/rules.ts';
export type { CancellationStage, Disclosure, DisclosureFacts, DisclosureLevel } from '../domain/rules.ts';
