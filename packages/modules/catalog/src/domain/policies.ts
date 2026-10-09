// catalog authorization policies (04 §6). Service discovery is anonymous by design (cacheable, rate-limited per IP) and
// returns only public reference data.
import { ALLOW, type PolicyRegistry } from '@hsp/policy';

export function registerCatalogPolicies(registry: PolicyRegistry): void {
  registry.define('catalog.categories.list', () => ALLOW);
  registry.define('catalog.symptoms.list', () => ALLOW);
}
