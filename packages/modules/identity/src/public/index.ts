// Public facade of module "identity". The ONLY entry other modules and apps may import (B1).
// Gate 3: phone OTP login, sessions (app bearer tokens with refresh rotation; BFF cookie sessions for browsers), step-up,
// IVR PIN credentials, identity erasure and the identity authorization policies.
export const moduleName = 'identity' as const;
export const schemaName = 'identity' as const;
export type { BotVerifier, OtpSender, SurfaceEligibility } from './ports.ts';
export { IdentityService, subjectKeyStore } from '../application/service.ts';
export type { IdentityDeps, IdentityKeys, LoginResult, PinVerification, RequestMeta, WebRequest } from '../application/service.ts';
export { registerIdentityPolicies } from '../domain/policies.ts';
export type { SessionResource } from '../domain/policies.ts';
export {
  ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_TTL_SEC, IVR_PIN, maskPhone, newDeviceApprovalHold, newDevicePayoutHold, OTP, phoneAllowed,
  pinRejectionReason, SESSION_COOKIE, SESSION_POLICY, STEP_UP_VALIDITY_MS, surfaceUsesBearerTokens,
} from '../domain/rules.ts';
export type { PhonePolicy, Surface } from '../domain/rules.ts';
/** Every identity SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as IDENTITY_SQL } from '../infrastructure/sql.ts';
