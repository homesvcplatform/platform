// Authorization engine (Phase 1 05 §5.1): every check is a pure function can(actor, action, resource, ctx) →
// Allow | Deny(reason), registered per action by the owning module and called from application services (not
// controllers). Unknown actions are denied (default deny, B11). Deny reasons are for internal logs only: clients get
// 403 (capability) or 404 (object-level, also for objects that don't exist).

export type ActorKind = 'ANONYMOUS' | 'CUSTOMER' | 'TECHNICIAN' | 'FIELD_AGENT' | 'ADMIN' | 'SYSTEM';
export type Surface = 'CUSTOMER_WEB' | 'TECHNICIAN_APP' | 'AGENT_WEB' | 'TECHNICIAN_IVR' | 'ADMIN';

/** An admin grant scope: global, or a set of city ids (05 §5.3). */
export type Scope = { readonly kind: 'GLOBAL' } | { readonly kind: 'CITIES'; readonly cityIds: readonly string[] };

export interface Actor {
  readonly kind: ActorKind;
  readonly id?: string;
  readonly sessionId?: string;
  readonly surface?: Surface;
  /** Admins only: permission → scopes, resolved server-side from current grants (never from the client). */
  readonly permissions?: ReadonlyMap<string, readonly Scope[]>;
  /** Time of the last step-up (OTP for public actors, WebAuthn assertion for admins). */
  readonly stepUpAt?: Date;
}

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly status: 403 | 404 };

export interface PolicyContext {
  readonly now: Date;
}

export type Policy<R> = (actor: Actor, resource: R, ctx: PolicyContext) => Decision;

export const ALLOW: Decision = { allow: true };
export const deny = (reason: string, status: 403 | 404 = 403): Decision => ({ allow: false, reason, status });

export class PolicyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

export interface DecisionRecord {
  readonly action: string;
  readonly actorKind: ActorKind;
  readonly allow: boolean;
  readonly reason?: string;
}

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;

export class PolicyRegistry {
  readonly #policies = new Map<string, Policy<never>>();
  readonly #onDecision: ((record: DecisionRecord) => void) | undefined;

  constructor(onDecision?: (record: DecisionRecord) => void) {
    this.#onDecision = onDecision;
  }

  define<R>(action: string, policy: Policy<R>): void {
    if (!ACTION.test(action)) throw new PolicyRegistryError(`invalid action name "${action}"`);
    if (this.#policies.has(action)) throw new PolicyRegistryError(`policy for "${action}" is already defined`);
    this.#policies.set(action, policy as Policy<never>);
  }

  has(action: string): boolean {
    return this.#policies.has(action);
  }

  actions(): string[] {
    return [...this.#policies.keys()].sort();
  }

  can<R>(actor: Actor, action: string, resource: R, ctx: PolicyContext): Decision {
    const policy = this.#policies.get(action) as Policy<R> | undefined;
    let decision: Decision;
    try {
      decision = policy ? policy(actor, resource, ctx) : deny('NO_POLICY');
    } catch {
      decision = deny('POLICY_ERROR');
    }
    this.#onDecision?.({ action, actorKind: actor.kind, allow: decision.allow, ...(decision.allow ? {} : { reason: decision.reason }) });
    return decision;
  }
}

/**
 * True when an admin actor holds `permission` with a scope covering `cityId`. Without `cityId` it accepts ANY scope
 * (city-agnostic checks only); global-by-definition permissions must use `hasGlobalPermission`.
 */
export function hasPermission(actor: Actor, permission: string, cityId?: string): boolean {
  if (actor.kind !== 'ADMIN' || !actor.permissions) return false;
  // Role definitions may grant a family with a trailing wildcard ("pii.reveal.*" covers "pii.reveal.address").
  const parts = permission.split('.');
  const names = [permission, ...parts.slice(1).map((_, i) => `${parts.slice(0, parts.length - 1 - i).join('.')}.*`)];
  const scopes = names.flatMap((n) => actor.permissions?.get(n) ?? []);
  if (scopes.length === 0) return false;
  if (cityId === undefined) return true;
  return scopes.some((s) => s.kind === 'GLOBAL' || s.cityIds.includes(cityId));
}

/**
 * True only when the admin holds `permission` through a GLOBAL grant. Use for permissions whose scope is global by
 * definition (security administration): `hasPermission(actor, p)` without a city accepts ANY scope, including a
 * city-only grant, and must not be used for them.
 */
export function hasGlobalPermission(actor: Actor, permission: string): boolean {
  if (actor.kind !== 'ADMIN' || !actor.permissions) return false;
  const parts = permission.split('.');
  const names = [permission, ...parts.slice(1).map((_, i) => `${parts.slice(0, parts.length - 1 - i).join('.')}.*`)];
  return names.some((n) => (actor.permissions?.get(n) ?? []).some((s) => s.kind === 'GLOBAL'));
}

/** True when the actor stepped up within `withinMs` of `now`. */
export function recentStepUp(actor: Actor, now: Date, withinMs: number): boolean {
  return actor.stepUpAt !== undefined && now.getTime() - actor.stepUpAt.getTime() <= withinMs && actor.stepUpAt <= now;
}
