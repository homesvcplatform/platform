// geo authorization policies (04 §5). Locality search and serviceability are anonymous by design and rate-limited per
// client IP; they return only public reference data (names, serviceable flag).
import { ALLOW, type PolicyRegistry } from '@hsp/policy';

export function registerGeoPolicies(registry: PolicyRegistry): void {
  registry.define('geo.localities.search', () => ALLOW);
  registry.define('geo.serviceability.check', () => ALLOW);
}
