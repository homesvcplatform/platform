// @hsp/kernel: IDs (UUIDv7), clock, config schema loading, environment guardrails, role runtime bootstrap.
export { ManualClock, systemClock } from './clock.ts';
export type { Clock } from './clock.ts';
export { fixtureId, isUuidV7, newId } from './ids.ts';
export type { Uuid } from './ids.ts';
export { baseEnvSchema, ConfigError, DEPLOYABLE_ENVIRONMENTS, loadConfig, PROCESS_ROLES } from './env.ts';
export type { AppEnvironment, BaseEnv, ProcessRole } from './env.ts';
export { assertExternalAdapterAllowed, assertNonProduction, GuardrailError, ivrProductionStateChangesEnabled } from './guards.ts';
export { bootstrapRole } from './runtime.ts';
export type { RunningRole } from './runtime.ts';
