// Public facade of module "customers". The ONLY entry other modules and apps may import (B1).
// Gate 5 (ADR-026 #2): read-only address interface for booking and the L2 disclosure path. Address create / edit: Gate 8.
export const moduleName = 'customers' as const;
export const schemaName = 'customers' as const;
export { CustomersService } from '../application/service.ts';
export type { BookingAddress, CustomersDeps, LocalityDirectory, OpenedAddress } from '../application/service.ts';
/** Every customers SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as CUSTOMERS_SQL } from '../infrastructure/sql.ts';
