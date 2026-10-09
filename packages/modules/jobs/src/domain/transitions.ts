// Transition tables of the fulfilment aggregates (Phase 1 06 §2–§4, §8; errata X-01, X-02). The single source of the
// allowed moves: application commands check them, and migration 0033 loads the same pairs into
// `jobs.allowed_transitions`, which the database triggers enforce (a DB test keeps the two equal).

export const MACHINES = {
  job: {
    initial: ['REQUESTED'],
    transitions: {
      REQUESTED: ['IN_DIAGNOSIS', 'CANCELLED'],
      IN_DIAGNOSIS: ['AWAITING_APPROVAL', 'AWAITING_PAYMENT', 'REQUESTED', 'CANCELLED'],
      AWAITING_APPROVAL: ['REPAIR_PENDING', 'REPAIR_IN_PROGRESS', 'AWAITING_PAYMENT', 'CLOSED', 'CANCELLED'],
      REPAIR_PENDING: ['REPAIR_IN_PROGRESS', 'CANCELLED'],
      REPAIR_IN_PROGRESS: ['AWAITING_APPROVAL', 'REPAIR_PENDING', 'AWAITING_PAYMENT'],
      AWAITING_PAYMENT: ['CLOSED'],
      CLOSED: [],
      CANCELLED: [],
    },
  },
  visit: {
    initial: ['PLANNED'],
    transitions: {
      PLANNED: ['MATCHING', 'CANCELLED'],
      MATCHING: ['ASSIGNED', 'UNFULFILLED', 'CANCELLED'],
      UNFULFILLED: ['MATCHING', 'CANCELLED'],
      ASSIGNED: ['EN_ROUTE', 'MATCHING', 'CANCELLED'],
      EN_ROUTE: ['ON_SITE', 'MATCHING', 'CUSTOMER_NO_SHOW', 'CANCELLED'],
      ON_SITE: ['IN_PROGRESS'],
      IN_PROGRESS: ['COMPLETED', 'ABORTED'],
      COMPLETED: [],
      CANCELLED: [],
      CUSTOMER_NO_SHOW: [],
      ABORTED: [],
    },
  },
  assignment: {
    initial: ['ACTIVE'],
    transitions: {
      ACTIVE: ['COMPLETED', 'RELEASED', 'NO_SHOW', 'REVOKED'],
      COMPLETED: [],
      RELEASED: [],
      NO_SHOW: [],
      REVOKED: [],
    },
  },
  repair_order: {
    initial: ['AWAITING_SCHEDULE', 'IN_PROGRESS'],
    transitions: {
      AWAITING_SCHEDULE: ['SCHEDULED', 'CANCELLED'],
      SCHEDULED: ['IN_PROGRESS', 'AWAITING_SCHEDULE', 'CANCELLED'],
      IN_PROGRESS: ['CHANGE_PENDING', 'BLOCKED', 'COMPLETED'],
      CHANGE_PENDING: ['IN_PROGRESS'],
      BLOCKED: ['AWAITING_SCHEDULE', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    },
  },
} as const;

export type Machine = keyof typeof MACHINES;
export type StateOf<M extends Machine> = keyof (typeof MACHINES)[M]['transitions'] & string;
export type JobStatus = StateOf<'job'>;
export type VisitStatus = StateOf<'visit'>;
export type AssignmentStatus = StateOf<'assignment'>;
export type RepairOrderStatus = StateOf<'repair_order'>;

export class InvalidTransitionError extends Error {
  readonly machine: Machine;
  readonly from: string;
  readonly to: string;
  constructor(machine: Machine, from: string, to: string) {
    super(`${machine}: ${from} → ${to} is not allowed`);
    this.name = 'InvalidTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export function statesOf(machine: Machine): string[] {
  return Object.keys(MACHINES[machine].transitions);
}

export function canTransition(machine: Machine, from: string, to: string): boolean {
  const next = (MACHINES[machine].transitions as Record<string, readonly string[]>)[from];
  return next !== undefined && next.includes(to);
}

export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new InvalidTransitionError(machine, from, to);
}

export function isTerminal(machine: Machine, state: string): boolean {
  const next = (MACHINES[machine].transitions as Record<string, readonly string[]>)[state];
  return next !== undefined && next.length === 0;
}

/** Every allowed (machine, from, to) triple: the content of `jobs.allowed_transitions`. */
export function allowedTransitions(): { machine: Machine; from: string; to: string }[] {
  return (Object.keys(MACHINES) as Machine[]).flatMap((machine) =>
    Object.entries(MACHINES[machine].transitions as Record<string, readonly string[]>)
      .flatMap(([from, tos]) => tos.map((to) => ({ machine, from, to }))));
}
