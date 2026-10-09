// Backoffice authorization policies (Phase 1 05 §5.3 / §5.4 / §6, §11 row "Grant roles": SEC M / C (not own); row
// "Edit pricing/rules": PRC M, CM C for city service rules through change requests, ADR-025 #5).
import { ALLOW, deny, hasGlobalPermission, hasPermission, type Actor, type PolicyRegistry } from '@hsp/policy';

export interface GrantResource {
  readonly granteeId: string;
  readonly requesterId: string | null;
}

/**
 * A change request's permission and city. `cityId` null = all cities (needs a GLOBAL grant); undefined = "in any scope"
 * (the maker pre-check before the input is validated).
 */
export interface ChangeResource {
  readonly permission: string;
  readonly cityId: string | null | undefined;
  readonly requesterId: string | null;
}

const inScope = (a: Actor, r: ChangeResource) =>
  r.cityId === null ? hasGlobalPermission(a, r.permission) : hasPermission(a, r.permission, r.cityId);

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
  // Change requests (ADR-025 #5): maker and checker need their permission for the change's city; the checker is never
  // the maker (INV-19). The checker's passkey step-up is bound to the change request and enforced in the decision.
  registry.define<ChangeResource>('backoffice.change.request', (a, r) => (a.kind === 'ADMIN' && inScope(a, r) ? ALLOW : deny('NO_CAPABILITY')));
  registry.define<ChangeResource>('backoffice.change.decide', (a, r) => {
    if (a.kind !== 'ADMIN' || !inScope(a, r)) return deny('NO_CAPABILITY');
    if (r.requesterId === a.id) return deny('CHECKER_CONFLICT');
    return ALLOW;
  });
}
