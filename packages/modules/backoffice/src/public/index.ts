// Public facade of module "backoffice". The ONLY entry other modules and apps may import (B1).
// Gate 3: admin realm authentication (IdP / zero-trust proxy assertion + admin session), passkey registration and
// step-up (SR-03), code-defined permissions, scoped grants with maker-checker, backoffice authorization policies.
export const moduleName = 'backoffice' as const;
export const schemaName = 'backoffice' as const;
export { BackofficeService, canonicalJson } from '../application/service.ts';
export type { AdminRequest, AdminRequestMeta, BackofficeDeps, GrantInput, IdpConfig } from '../application/service.ts';
export { registerBackofficePolicies } from '../domain/policies.ts';
export type { GrantResource } from '../domain/policies.ts';
export {
  ADMIN_COOKIE, ADMIN_PERMISSIONS, ADMIN_SESSION, ADMIN_STEP_UP_MS, isKnownPermissionEntry, isPhishingResistant, passkeyCeremoniesAllowed,
  PERMISSIONS_VERSION, STEP_UP_OPERATIONS, WEBAUTHN_INDEPENDENT_REVIEW_PASSED,
} from '../domain/permissions.ts';
export type { AdminPermission, StepUpOperation } from '../domain/permissions.ts';
/** Every backoffice SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as BACKOFFICE_SQL } from '../infrastructure/sql.ts';
