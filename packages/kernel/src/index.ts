// @hsp/kernel: config schema loading, environment guardrails, role runtime bootstrap.
// IDs (UUIDv7) and clock arrive at Gate 2.
export { baseEnvSchema, ConfigError, DEPLOYABLE_ENVIRONMENTS, loadConfig, PROCESS_ROLES } from './env.ts';
export type { AppEnvironment, BaseEnv, ProcessRole } from './env.ts';
export { assertExternalAdapterAllowed, assertNonProduction, GuardrailError, ivrProductionStateChangesEnabled } from './guards.ts';
export { bootstrapRole } from './runtime.ts';
export type { RunningRole } from './runtime.ts';
