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

export const approvalDecision = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
});
