// HTTP surface of module "geo" (Phase 1 04 §5), registered by the `api` app. Framework-neutral handlers (ADR-024 #1):
// anonymous, rate-limited per client IP (resolved by the app, SR-10). No CORS headers are ever produced.
import { geo as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { GeoService, PublicRequestMeta } from '../application/service.ts';

export interface PublicHttpRequest {
  readonly method: string;
  readonly path: string;
  /** Decoded query parameters (first value of each). */
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly meta: PublicRequestMeta;
}

export interface PublicHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const geoEndpoints: readonly EndpointSpec[] = [
  { method: 'GET', path: '/v1/geo/localities', surface: 'public', action: 'geo.localities.search', idempotency: 'implicit', rateClass: 'PUBLIC_READ' },
  { method: 'POST', path: '/v1/geo/serviceability', surface: 'public', action: 'geo.serviceability.check', idempotency: { none: 'read-only check: no state changes' }, rateClass: 'PUBLIC_READ' },
];

const ANONYMOUS = { kind: 'ANONYMOUS' } as const;

const json = (status: number, body: unknown): PublicHttpResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body,
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

export function createGeoHttp(service: GeoService): (req: PublicHttpRequest) => Promise<PublicHttpResponse> {
  return async (req) => {
    try {
      const route = `${req.method.toUpperCase()} ${req.path}`;
      switch (route) {
        case 'GET /v1/geo/localities': {
          const q = parse(contracts.localitySearchQuery, { ...req.query });
          const r = await service.searchLocalities(ANONYMOUS, { cityId: q.cityId, q: q.q, locale: q.locale }, req.meta);
          return json(200, { locale: r.locale, items: r.items });
        }
        case 'POST /v1/geo/serviceability':
          return json(200, await service.checkServiceability(ANONYMOUS, parse(contracts.serviceabilityRequest, req.body), req.meta));
        default:
          throw new AppError('NOT_FOUND');
      }
    } catch (error) {
      const problem = toProblem(error, req.meta.requestId);
      const retry = error instanceof AppError && error.retryAfterSec !== undefined ? { 'retry-after': String(error.retryAfterSec) } : {};
      return { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...retry }, body: problem };
    }
  };
}
