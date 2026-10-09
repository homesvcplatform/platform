// TCP-3 placeholder (G-1, ADR-026 #10): a deterministic stand-in for `payments.issueBill` until Gate 11. It is wired
// through the jobs `BillIssuer` port and called inside the jobs command's transaction (never bypassed), writes
// nothing, and derives the bill id from (job, visit, kind) and the amount from the immutable price snapshot.
// Gate 11 replaces it with the real bill writer.
import { createHash } from 'node:crypto';

export interface SnapshotReader {
  snapshotOutputs(snapshotId: string): Promise<Record<string, unknown> | null>;
}

export interface PlaceholderBill {
  readonly billId: string;
  readonly amountDuePaise: bigint;
}

function uuidFrom(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createPlaceholderBillIssuer(pricing: SnapshotReader) {
  return {
    async issueBill(_tx: { readonly transactionId: string },
      input: { readonly jobId: string; readonly visitId: string; readonly kind: string; readonly priceSnapshotId: string }): Promise<PlaceholderBill> {
      const outputs = await pricing.snapshotOutputs(input.priceSnapshotId);
      const fee = outputs?.['customerFeePaise'];
      if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0) throw new Error('placeholder bill: snapshot has no customer fee');
      return { billId: uuidFrom(`bill|${input.jobId}|${input.visitId}|${input.kind}`), amountDuePaise: BigInt(fee) };
    },
  };
}
