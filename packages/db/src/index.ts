// @hsp/db: connection pools per process role, forward-only migrations, query ownership guard (B2) and unit of work
// limited to the approved transactional coupling points (B4), the hash-chained audit writer and idempotency records.
export { appendAudit, AuditEntryError, validateChangeSummary } from './audit.ts';
export type { AuditActorType, AuditEntry, AuditOutcome, AuditValue } from './audit.ts';
export { beginIdempotent, completeIdempotent, DEFAULT_IDEMPOTENCY_TTL_MS, IdempotencyConflict } from './idempotency.ts';
export type { IdempotencyRequest, IdempotencyStart } from './idempotency.ts';
export { bootstrapCluster, bootstrapDatabase, REQUIRED_EXTENSIONS } from './bootstrap.ts';
export { checksumOf, loadMigrations, MigrationError, parseMigrations, runMigrations } from './migrate.ts';
export type { Migration, MigrationRunResult, Queryable, RunOptions } from './migrate.ts';
export { assertRuntimeIdentity, createRolePool, DatabaseIdentityError, withTransaction } from './pool.ts';
export type { RolePoolOptions } from './pool.ts';
export { allSchemas, assertModuleOwnsSql, ModuleBoundaryError, ownershipFromModulesJson, referencedSchemas } from './query-guard.ts';
export type { SchemaOwnership } from './query-guard.ts';
export { ALL_DB_GROUP_ROLES, DB_ROLE_FOR_PROCESS, MIGRATOR_ROLE, RESTRICTED_DB_ROLES, RUNTIME_DB_ROLES } from './roles.ts';
export type { RuntimeDbRole } from './roles.ts';
export { TransactionBoundaryError, UnitOfWork } from './unit-of-work.ts';
export { cancelTimer, installTimerQueue, scheduleTimer, startTimerRunner, TIMER_SCHEMA } from './timers.ts';
export type { TimerRequest, TimerRunnerOptions } from './timers.ts';
export type { TransactionalCouplingPoint } from './unit-of-work.ts';
