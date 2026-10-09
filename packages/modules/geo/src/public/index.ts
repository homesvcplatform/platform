// Public facade of module "geo". The ONLY entry other modules and apps may import (B1).
// Gate 4: cities, zones, localities, aliases, adjacency; locality search, serviceability, zone and travel estimates.
export const moduleName = 'geo' as const;
export const schemaName = 'geo' as const;
export { GeoService } from '../application/service.ts';
export { cityLocalesChangeAction, repositoryCatalogIssues } from '../application/changes.ts';
export type { City, GeoDeps, PublicRequestMeta } from '../application/service.ts';
export { isInIndia, normalizeSearchText, shortestTravel } from '../domain/geo.ts';
export type { AdjacencyEdge } from '../domain/geo.ts';
export { registerGeoPolicies } from '../domain/policies.ts';
/** Every geo SQL statement (for the B2 schema-ownership fitness test). */
export { SQL as GEO_SQL } from '../infrastructure/sql.ts';
