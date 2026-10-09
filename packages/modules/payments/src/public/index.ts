// Public facade of module "payments". The ONLY entry other modules and apps may import (B1).
// Gate 5: the deterministic TCP-3 placeholder bill issuer (ADR-026 #10). Real bills, payments and the ledger: Gate 11.
export const moduleName = 'payments' as const;
export const schemaName = 'payments' as const;
export { createPlaceholderBillIssuer } from '../application/placeholder-bill-issuer.ts';
export type { PlaceholderBill, SnapshotReader } from '../application/placeholder-bill-issuer.ts';
