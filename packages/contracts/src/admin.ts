// Phase 1 04 (admin surface): admin login through the zero-trust proxy / IdP, passkey ceremonies and role grants.
import { z } from 'zod';

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(16_384);

export const passkeyRegistrationFinish = z.strictObject({
  challengeId: z.uuid(),
  clientDataJSON: b64url,
  attestationObject: b64url,
});

export const passkeyAssertion = z.strictObject({
  challengeId: z.uuid(),
  credentialId: b64url,
  clientDataJSON: b64url,
  authenticatorData: b64url,
  signature: b64url,
});

export const grantRequest = z.strictObject({
  adminUserId: z.uuid(),
  roleCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('GLOBAL') }),
    z.strictObject({ kind: z.literal('CITIES'), cityIds: z.array(z.uuid()).min(1).max(50) }),
  ]),
  expiresAt: z.iso.datetime().optional(),
});

/** The step-up returned by POST /admin/v1/step-up, bound by the server to this approval request and its payload. */
export const approvalDecision = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
  stepUpId: z.uuid(),
});

/**
 * The client selects one server-defined operation; the server binds the resource (approval request + payload hash).
 * A grant-decision step-up is also bound to the decision it will be used for.
 */
export const stepUpOptions = z.strictObject({
  operation: z.enum(['security.grant.decide', 'backoffice.change.decide', 'backoffice.passkey.register']),
  approvalRequestId: z.uuid().optional(),
  decision: z.enum(['APPROVE', 'REJECT']).optional(),
});

/**
 * A two-person approved configuration change (ADR-025 #5). `change` is validated by the module that owns the action
 * type (e.g. `catalog.service_rules.set`, `geo.city.locales.set`).
 */
export const changeRequest = z.strictObject({
  actionType: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/).max(80),
  change: z.record(z.string(), z.unknown()),
});

/** Needed only for an additional passkey (a step-up bound to backoffice.passkey.register). */
export const passkeyRegistrationOptions = z.strictObject({
  stepUpId: z.uuid().optional(),
});
