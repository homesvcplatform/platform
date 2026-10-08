// @hsp/policy: authorization engine (can(actor, action, resource, ctx), default deny), admin permission/scope helpers
// and the V1 authorization matrix (Phase 1 05 §11) that the matrix test generator in @hsp/testing expands.
export { ALLOW, deny, hasPermission, PolicyRegistry, PolicyRegistryError, recentStepUp } from './engine.ts';
export type { Actor, ActorKind, Decision, DecisionRecord, Policy, PolicyContext, Scope, Surface } from './engine.ts';
export { AUTHZ_MATRIX, cellAllows, MATRIX_COLUMNS } from './matrix.ts';
export type { MatrixColumn, MatrixRow } from './matrix.ts';
export { assertEndpointRegistry, EndpointRegistryError } from './endpoints.ts';
export type { EndpointSpec, HttpMethod } from './endpoints.ts';
