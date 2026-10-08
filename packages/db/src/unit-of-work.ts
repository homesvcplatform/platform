// B4 (Phase 2 02 §3): cross-module calls may join an open transaction only at the approved transactional coupling
// points TCP-1/2/3 (tools/architecture/modules.json, ADR-022). Every other cross-module interaction is asynchronous
// (outbox events) and must not share a database transaction.

export interface TransactionalCouplingPoint {
  readonly id: string;
  readonly caller: string;
  readonly callee: string;
  readonly operation: string;
}

export class TransactionBoundaryError extends Error {
  constructor(caller: string, callee: string, operation: string) {
    super(`"${caller}" may not call "${callee}.${operation}" inside its transaction (B4): only TCP-1/2/3 may join a unit of work`);
    this.name = 'TransactionBoundaryError';
  }
}

export class UnitOfWork {
  readonly owner: string;
  readonly #tcps: readonly TransactionalCouplingPoint[];
  readonly #joined: string[] = [];

  constructor(owner: string, tcps: readonly TransactionalCouplingPoint[]) {
    this.owner = owner;
    this.#tcps = tcps;
  }

  /**
   * Called by a module facade before doing transactional work for `caller` inside this unit of work.
   * Same-module work is always allowed; cross-module work only along an approved TCP.
   */
  join(caller: string, callee: string, operation: string): void {
    if (caller === callee) return;
    const tcp = this.#tcps.find((t) => t.caller === caller && t.callee === callee && t.operation === operation);
    if (!tcp) throw new TransactionBoundaryError(caller, callee, operation);
    this.#joined.push(`${tcp.id}:${callee}.${operation}`);
  }

  /** Coupling points used so far (for logs and tests). */
  get joined(): readonly string[] {
    return [...this.#joined];
  }
}
