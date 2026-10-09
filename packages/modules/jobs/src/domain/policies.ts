// jobs authorization policies (Phase 1 05 §11 rows "Create booking" (CUS O, SUP-L1/L2 S), "Cancel job" (CUS O),
// "Manual assignment" (DISP S), "Depart/arrive (with code)" (TEC-APP O), "Complete repair (code)" (TEC-APP O),
// "Presence override" (change requests), 04 §7 / §10 / §12). Object-level checks return 404 so another customer's job or another technician's visit isn't confirmed to exist.
import { ALLOW, deny, hasPermission, type Actor, type PolicyRegistry } from '@hsp/policy';

export interface OwnedResource {
  readonly ownerUserId: string | null;
}

export interface AssigneeResource {
  /** read: the technician has (or had) an assignment on this visit; act: it is the ACTIVE assignment. */
  readonly isAssignee: boolean;
}

export interface CityResource {
  /** undefined = "in any city" (pre-check before the target is known). */
  readonly cityId: string | undefined;
}

const customerSession = (a: Actor) => a.kind === 'CUSTOMER' && a.id !== undefined && a.sessionId !== undefined && a.surface === 'CUSTOMER_WEB';
const technicianApp = (a: Actor) => a.kind === 'TECHNICIAN' && a.id !== undefined && a.sessionId !== undefined && a.surface === 'TECHNICIAN_APP';
const scoped = (a: Actor, permission: string, r: CityResource) =>
  a.kind === 'ADMIN' && (r.cityId === undefined ? hasPermission(a, permission) : hasPermission(a, permission, r.cityId));

export function registerJobsPolicies(registry: PolicyRegistry): void {
  registry.define('jobs.job.create', (a) => (customerSession(a) ? ALLOW : deny('NOT_A_CUSTOMER_SESSION')));
  // Gate 6 (04 §11–§12): the customer's repair order (read, schedule, cancel) and the repair visit's completion code.
  for (const action of ['jobs.job.read', 'jobs.job.cancel', 'jobs.visit.start_code', 'jobs.visit.completion_code', 'jobs.repair_order.read',
    'jobs.repair_order.schedule', 'jobs.repair_order.cancel']) {
    registry.define<OwnedResource>(action, (a, r) => (customerSession(a) && r.ownerUserId === a.id ? ALLOW : deny('NOT_OWNER', 404)));
  }
  // The IVR surface gets its own commands with the IVR gate (Gate 10).
  for (const action of ['jobs.visit.read_assigned', 'jobs.visit.act']) {
    registry.define<AssigneeResource>(action, (a, r) => (technicianApp(a) && r.isAssignee ? ALLOW : deny('NOT_ASSIGNEE', 404)));
  }
  registry.define<CityResource>('jobs.job.create_assisted', (a, r) => (scoped(a, 'support.book', r) ? ALLOW : deny('NO_CAPABILITY')));
  registry.define<CityResource>('jobs.job.confirm_customer', (a, r) => (scoped(a, 'support.book', r) ? ALLOW : deny('NO_CAPABILITY')));
  registry.define<CityResource>('jobs.visit.assign_manual', (a, r) => (scoped(a, 'dispatch.assign', r) ? ALLOW : deny('NO_CAPABILITY')));
  registry.define<CityResource>('jobs.visit.ops_wait', (a, r) => (scoped(a, 'dispatch.assign', r) ? ALLOW : deny('NO_CAPABILITY')));
}
