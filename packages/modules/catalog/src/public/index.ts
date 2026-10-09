// Public facade of module "catalog". The ONLY entry other modules and apps may import (B1).
// Gate 4: category / service-type / symptom / repair-item / material reads, city service rules (enablement is data).
export const moduleName = 'catalog' as const;
export const schemaName = 'catalog' as const;
export { CatalogService } from '../application/service.ts';
export { serviceRulesChangeAction } from '../application/changes.ts';
export type { CatalogDeps, CityDirectory, PublicRequestMeta, RepairItem } from '../application/service.ts';
export { effectiveRule, parseServiceRules, serviceRulesSchema } from '../domain/rules.ts';
export type { ServiceRules } from '../domain/rules.ts';
export { registerCatalogPolicies } from '../domain/policies.ts';
/** Every catalog SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as CATALOG_SQL } from '../infrastructure/sql.ts';
