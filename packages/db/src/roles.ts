// Database roles (Phase 1 03 §12.1, ADR-019, errata G-5). Grants are per *process role*, not per module: one pool per
// process cannot switch roles per module call. Module isolation is enforced in code (B2 query guard, B4 unit of work).
import type { ProcessRole } from '@hsp/kernel';

/** Owner of every schema and object. Runs migrations only (CI / deploy pipeline). Never used at runtime. */
export const MIGRATOR_ROLE = 'migrator';

/** Group roles granted to the runtime login users of each process (NOLOGIN themselves). */
export const RUNTIME_DB_ROLES = ['app_api', 'app_admin', 'app_webhook', 'app_voice', 'app_worker'] as const;
export type RuntimeDbRole = (typeof RUNTIME_DB_ROLES)[number];

/**
 * Roles with no privileges in Gate 2:
 * - retention_executor: partition detach/drop jobs (privileges arrive with the retention job).
 * - ops_readonly / analytics_etl: SELECT on masked / pseudonymised views only; those views arrive with the admin
 *   console and analytics work, so until then they can read nothing (deny-all by absence of grants).
 */
export const RESTRICTED_DB_ROLES = ['retention_executor', 'ops_readonly', 'analytics_etl'] as const;

export const ALL_DB_GROUP_ROLES = [...RUNTIME_DB_ROLES, ...RESTRICTED_DB_ROLES] as const;

/** Which database role each process role runs as. `null` means the process has no database access at all. */
export const DB_ROLE_FOR_PROCESS: Readonly<Record<ProcessRole, RuntimeDbRole | null>> = {
  api: 'app_api',
  'admin-api': 'app_admin',
  webhook: 'app_webhook',
  voice: 'app_voice',
  worker: 'app_worker',
  scheduler: 'app_worker',
  'media-scanner': null, // SR-09: the decoder/scanner task has no DB role
};
// Frontends (web-bff, admin-web, technician-app) are not process roles here and never reach the database (rule 9).
