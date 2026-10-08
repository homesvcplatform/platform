// Endpoint declarations (boundary rules B11 / B12): every HTTP handler declares the policy action that authorises
// it and its idempotency behaviour. Apps call `assertEndpointRegistry` at boot (and CI runs it in tests): a handler
// without a registered policy, or a mutating handler without an idempotency declaration, refuses to start.
import type { PolicyRegistry } from './engine.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly surface: 'public' | 'customer' | 'technician' | 'agent' | 'session' | 'admin';
  readonly action: string;
  /** 04 §1.3: "required" (Idempotency-Key header), "implicit" (single-use token / state-idempotent), "none" (with reason). */
  readonly idempotency: 'required' | 'implicit' | { readonly none: string };
  readonly rateClass: string;
}

export class EndpointRegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Endpoint registry invalid: ${problems.join('; ')}`);
    this.name = 'EndpointRegistryError';
    this.problems = problems;
  }
}

export function assertEndpointRegistry(endpoints: readonly EndpointSpec[], registry: PolicyRegistry): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    const id = `${e.method} ${e.path}`;
    if (seen.has(id)) problems.push(`${id}: declared twice`);
    seen.add(id);
    if (!registry.has(e.action)) problems.push(`${id}: no policy registered for "${e.action}" (B11)`);
    if (e.method !== 'GET' && typeof e.idempotency === 'object' && e.idempotency.none.trim().length < 10) {
      problems.push(`${id}: a mutating endpoint without idempotency needs a stated reason (B12)`);
    }
    if (!/^\/(v1|admin\/v1)\//.test(e.path)) problems.push(`${id}: path must be under /v1 or /admin/v1`);
  }
  if (problems.length > 0) throw new EndpointRegistryError(problems);
}
