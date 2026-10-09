// Public facade of module "workforce". The ONLY entry other modules and apps may import (B1).
// Gate 5: read-only technician facts for manual assignment (ADR-026 #11).
export const moduleName = 'workforce' as const;
export const schemaName = 'workforce' as const;
export { TechnicianDirectory, WORKFORCE_SQL } from '../application/technicians.ts';
