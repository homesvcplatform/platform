// Backoffice authorization policies (Phase 1 05 §5.3 / §5.4 / §6, §11 row "Grant roles": SEC M / C (not own)).
import { ALLOW, deny, hasGlobalPermission, type PolicyRegistry } from '@hsp/policy';

export interface GrantResource {
  readonly granteeId: string;
  readonly requesterId: string | null;
}

export function registerBackofficePolicies(registry: PolicyRegistry): void {
  registry.define('backoffice.login', () => ALLOW); // gated by the IdP assertion itself
  registry.define('backoffice.session.logout', (a) => (a.kind === 'ADMIN' && a.sessionId ? ALLOW : deny('NOT_ADMIN')));
  registry.define('backoffice.passkey.manage', (a) => (a.kind === 'ADMIN' && a.sessionId ? ALLOW : deny('NOT_ADMIN')));
  registry.define<GrantResource>('backoffice.grant.request', (a, r) => {
    // Security administration is global (05 §5.3): a city-scoped grant of these permissions never authorises it.
    if (!hasGlobalPermission(a, 'security.grant')) return deny('NO_CAPABILITY');
    if (r.granteeId === a.id) return deny('SELF_GRANT'); // 05 §6: nobody grants themselves
    return ALLOW;
  });
  // The passkey step-up for a decision is bound to the approval request and enforced in the decision transaction.
  registry.define<GrantResource>('backoffice.grant.decide', (a, r) => {
    if (!hasGlobalPermission(a, 'security.grant.approve')) return deny('NO_CAPABILITY');
    if (r.requesterId === a.id || r.granteeId === a.id) return deny('CHECKER_CONFLICT'); // INV-19 + not the grantee
    return ALLOW;
  });
}
