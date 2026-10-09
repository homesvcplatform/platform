// Change requests (ADR-025 #5): two-person approved configuration changes owned by other modules. The owning module
// defines the action (permissions, validation, idempotent execution in its own transaction); the app wires it here.
// The shape is structural, so the owning module never imports backoffice (no new module dependency).
import { ADMIN_PERMISSIONS } from './permissions.ts';

export type ChangeSummaryValue = boolean | number | null | string | readonly string[];

export interface PreparedChange {
  /** The exact payload the checker approves (hashed; executed as stored). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly resourceId: string | null;
  /** The city the change applies to; null = all cities (needs GLOBAL grants). */
  readonly cityId: string | null;
  /** Enum-like audit summary (no free text, no personal data). */
  readonly summary: Readonly<Record<string, ChangeSummaryValue>>;
}

export interface ChangeExecutionContext {
  readonly now: Date;
  readonly actorId: string;
  readonly requestId: string;
}

export interface ChangeAction {
  /** e.g. `catalog.service_rules.set`. */
  readonly actionType: string;
  readonly resourceType: string;
  /** Code-defined admin permissions (05 §5.3). */
  readonly makerPermission: string;
  readonly checkerPermission: string;
  readonly riskLevel: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Validates the maker's input. Throws AppError (VALIDATION_FAILED / INVALID_STATE) when it can't be proposed. */
  prepare(input: unknown, now: Date): Promise<PreparedChange>;
  /** The city a stored payload applies to (pure; used for the checker's scope). */
  cityOf(payload: Readonly<Record<string, unknown>>): string | null;
  /** Applies an approved payload in the owning module's own transaction. Idempotent per change request id. */
  execute(changeRequestId: string, payload: Readonly<Record<string, unknown>>, ctx: ChangeExecutionContext): Promise<void>;
}

const ACTION_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;

/** Boot-time check of the wired actions: unique, well-formed, permissions from the code-defined list, not role grants. */
export function changeActionRegistry(actions: readonly ChangeAction[]): ReadonlyMap<string, ChangeAction> {
  const map = new Map<string, ChangeAction>();
  const known = new Set<string>(ADMIN_PERMISSIONS);
  for (const a of actions) {
    if (!ACTION_TYPE.test(a.actionType) || a.actionType.startsWith('security.')) throw new Error(`invalid change action type "${a.actionType}"`);
    if (map.has(a.actionType)) throw new Error(`change action "${a.actionType}" registered twice`);
    if (!known.has(a.makerPermission) || !known.has(a.checkerPermission) || a.makerPermission === a.checkerPermission) {
      throw new Error(`change action "${a.actionType}" needs two distinct code-defined permissions`);
    }
    map.set(a.actionType, a);
  }
  return map;
}
