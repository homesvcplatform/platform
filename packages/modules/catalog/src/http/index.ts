// HTTP surface of module "catalog" (Phase 1 04 §6), registered by the `api` app. Framework-neutral handlers
// (ADR-024 #1): anonymous, rate-limited per client IP, cacheable for 5 minutes. No CORS headers are ever produced.
import { catalog as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { CatalogService, PublicRequestMeta } from '../application/service.ts';

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

export const catalogEndpoints: readonly EndpointSpec[] = [
  { method: 'GET', path: '/v1/catalog/categories', surface: 'public', action: 'catalog.categories.list', idempotency: 'implicit', rateClass: 'PUBLIC_READ' },
  { method: 'GET', path: '/v1/catalog/service-types/:serviceTypeId/symptoms', surface: 'public', action: 'catalog.symptoms.list', idempotency: 'implicit', rateClass: 'PUBLIC_READ' },
];

const ANONYMOUS = { kind: 'ANONYMOUS' } as const;
const SYMPTOMS_PATH = /^\/v1\/catalog\/service-types\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/symptoms$/;

// 04 §6: cacheable for 5 minutes (the CDN keys on the full URL, including cityId and locale).
const cached = (body: unknown): PublicHttpResponse => ({
  status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }, body,
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

export function createCatalogHttp(service: CatalogService): (req: PublicHttpRequest) => Promise<PublicHttpResponse> {
  return async (req) => {
    try {
      const method = req.method.toUpperCase();
      if (method === 'GET' && req.path === '/v1/catalog/categories') {
        const q = parse(contracts.categoriesQuery, { ...req.query });
        return cached(await service.listCategories(ANONYMOUS, { cityId: q.cityId, locale: q.locale }, req.meta));
      }
      const symptoms = SYMPTOMS_PATH.exec(req.path);
      if (method === 'GET' && symptoms?.[1]) {
        const q = parse(contracts.symptomsQuery, { ...req.query });
        return cached(await service.listSymptoms(ANONYMOUS, { serviceTypeId: symptoms[1], cityId: q.cityId, locale: q.locale }, req.meta));
      }
      throw new AppError('NOT_FOUND');
    } catch (error) {
      const problem = toProblem(error, req.meta.requestId);
      const retry = error instanceof AppError && error.retryAfterSec !== undefined ? { 'retry-after': String(error.retryAfterSec) } : {};
      return { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...retry }, body: problem };
    }
  };
}
