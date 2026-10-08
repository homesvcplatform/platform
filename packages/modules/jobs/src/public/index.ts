// Public facade of module "jobs". The ONLY entry other modules and apps may import (B1).
export const moduleName = 'jobs' as const;
export const schemaName = 'jobs' as const;
export type { BillIssuer, MaterialUsageRecorder, TransactionContext } from './ports.ts';
