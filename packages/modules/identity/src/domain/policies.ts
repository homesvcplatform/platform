// Identity authorization policies (Phase 1 05 §5, §11 row "Revoke sessions"). Default deny everywhere else.
import { ALLOW, deny, hasGlobalPermission, type Actor, type PolicyRegistry } from '@hsp/policy';

const PUBLIC_KINDS = new Set(['CUSTOMER', 'TECHNICIAN', 'FIELD_AGENT']);
const isPublicSession = (a: Actor) => PUBLIC_KINDS.has(a.kind) && a.id !== undefined && a.sessionId !== undefined;

export interface SessionResource {
  readonly ownerUserId: string | null;
  readonly reasonCode: string | null;
}

export function registerIdentityPolicies(registry: PolicyRegistry): void {
  // Anonymous entry points still declare a policy (B11): they are open by design and rate-limited.
  for (const action of ['identity.otp.request', 'identity.otp.verify', 'identity.token.refresh']) {
    registry.define(action, () => ALLOW);
  }
  registry.define('identity.logout', (a) => (isPublicSession(a) ? ALLOW : deny('NOT_A_PUBLIC_SESSION')));
  registry.define('identity.step_up', (a) => (isPublicSession(a) && a.surface !== 'TECHNICIAN_IVR' ? ALLOW : deny('NOT_A_PUBLIC_SESSION')));
  registry.define('identity.session.list', (a) => (isPublicSession(a) ? ALLOW : deny('NOT_A_PUBLIC_SESSION')));
  registry.define<SessionResource>('identity.session.revoke', (a, r) => {
    // Matrix: CUS / TEC-APP / AGT "own"; TEC-IVR ❌; SEC ✅ (security.sessions.revoke), held only by the global-only
    // SECURITY_ADMIN role. ADR-024 R12: users carry no city, so the permission counts only from a GLOBAL grant.
    if (a.surface === 'TECHNICIAN_IVR') return deny('IVR_CANNOT_REVOKE');
    if (isPublicSession(a)) return r.ownerUserId === a.id ? ALLOW : deny('NOT_OWNER', 404);
    if (a.kind === 'ADMIN' && hasGlobalPermission(a, 'security.sessions.revoke')) return r.reasonCode ? ALLOW : deny('REASON_REQUIRED');
    return deny('NO_CAPABILITY');
  });
}
