// TCP-3 placeholder (G-1, ADR-026 #10, ADR-027 #8): a deterministic stand-in for `payments.issueBill` until Gate 11. It
// is wired through the jobs `BillIssuer` port and called inside the jobs command's transaction (never bypassed), writes
// nothing, and derives the bill id from (job, visit, kind) and the amount from the immutable price snapshot:
// - CANCELLATION_FEE / NO_SHOW_FEE (Gate 5): `customerFeePaise` of the fee snapshot;
// - VISIT_FEE (Gate 6: no repair needed, quote rejected / expired, repair order cancelled): `visitFeePaise` of the
//   booking's visit-fee snapshot;
// - REPAIR_COMPLETION (Gate 6): `amountDuePaise` of the completion snapshot (approved total − unused material + fees).
// Gate 11 replaces it with the real bill writer (bill lines, prior-payment credits, ledger).
import { createHash } from 'node:crypto';

export interface SnapshotReader {
  snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null>;
}

export interface PlaceholderBill {
  readonly billId: string;
  readonly amountDuePaise: bigint;
}

export type PlaceholderBillKind = 'CANCELLATION_FEE' | 'NO_SHOW_FEE' | 'VISIT_FEE' | 'REPAIR_COMPLETION';

const AMOUNT_FIELD: Readonly<Record<PlaceholderBillKind, string>> = {
  CANCELLATION_FEE: 'customerFeePaise',
  NO_SHOW_FEE: 'customerFeePaise',
  VISIT_FEE: 'visitFeePaise',
  REPAIR_COMPLETION: 'amountDuePaise',
};

function uuidFrom(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createPlaceholderBillIssuer(pricing: SnapshotReader) {
  return {
    async issueBill(_tx: { readonly transactionId: string },
      input: { readonly jobId: string; readonly visitId: string; readonly kind: PlaceholderBillKind; readonly priceSnapshotId: string }): Promise<PlaceholderBill> {
      const field = AMOUNT_FIELD[input.kind];
      if (!field) throw new Error('placeholder bill: unknown kind');
      const outputs = await pricing.snapshotOutputs(input.priceSnapshotId);
      const amount = outputs?.[field];
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) throw new Error('placeholder bill: snapshot has no amount for this kind');
      return { billId: uuidFrom(`bill|${input.jobId}|${input.visitId}|${input.kind}`), amountDuePaise: BigInt(amount) };
    },
  };
}
