// Ports owned by the jobs module for its transactional coupling points (ADR-022).
// Callee modules implement these; apps wire them. jobs never imports diagnosis or payments,
// so the compile-time dependency graph stays acyclic while TCP-2/TCP-3 remain single-transaction calls.

/** Opaque handle to the caller's open database transaction (defined in @hsp/db at Gate 2). */
export interface TransactionContext {
  readonly transactionId: string;
}

/** TCP-2: record materials actually used in the same transaction as visit completion. */
export interface MaterialUsageRecorder {
  recordMaterialUsage(
    tx: TransactionContext,
    input: { readonly repairOrderId: string; readonly visitId: string },
  ): Promise<void>;
}

/** TCP-3: issue the deterministic bill in the same transaction as visit completion (G-1). */
export interface BillIssuer {
  issueBill(
    tx: TransactionContext,
    input: { readonly jobId: string; readonly visitId: string },
  ): Promise<{ readonly billId: string; readonly amountDuePaise: bigint }>;
}
