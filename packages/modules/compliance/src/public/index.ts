// Public facade of module "compliance". The ONLY entry other modules and apps may import (B1).
// Gate 5: the disclosure log used by the jobs disclosure service (INV-17). The audit writer is @hsp/db (platform).
export const moduleName = 'compliance' as const;
export const schemaName = 'compliance' as const;
export { COMPLIANCE_SQL, recordDisclosure } from '../application/disclosure.ts';
export type { DisclosureEvent } from '../application/disclosure.ts';
