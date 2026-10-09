// HTTP surface of module "jobs" (Phase 1 04 §7, §10; Gate 5 subset). Framework-neutral handlers (ADR-024 #1): the app
// resolves the actor (customer / technician session via identity, admin via backoffice) and passes it in through
// `authenticate`. No CORS headers are ever produced.
import { jobs as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { Actor, EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { JobsService, RequestMeta } from '../application/service.ts';

export interface JobsHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly meta: RequestMeta;
}

export interface JobsHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const jobsEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/v1/customer/jobs', surface: 'customer', action: 'jobs.job.create', idempotency: 'required', rateClass: 'CRITICAL' },
  { method: 'GET', path: '/v1/customer/jobs/:jobId', surface: 'customer', action: 'jobs.job.read', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'GET', path: '/v1/customer/jobs/:jobId/cancellation-preview', surface: 'customer', action: 'jobs.job.cancel', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'POST', path: '/v1/customer/jobs/:jobId/cancel', surface: 'customer', action: 'jobs.job.cancel', idempotency: 'required', rateClass: 'CRITICAL' },
  { method: 'POST', path: '/v1/customer/visits/:visitId/start-code', surface: 'customer', action: 'jobs.visit.start_code', idempotency: { none: 'issues a fresh code; the previous one stops working' }, rateClass: 'WRITE' },
  { method: 'GET', path: '/v1/technician/visits/:visitId', surface: 'technician', action: 'jobs.visit.read_assigned', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'POST', path: '/v1/technician/visits/:visitId/depart', surface: 'technician', action: 'jobs.visit.act', idempotency: 'required', rateClass: 'WRITE' },
  { method: 'POST', path: '/v1/technician/visits/:visitId/arrive', surface: 'technician', action: 'jobs.visit.act', idempotency: 'required', rateClass: 'CODE_ENTRY' },
  { method: 'POST', path: '/v1/technician/visits/:visitId/wait/start', surface: 'technician', action: 'jobs.visit.act', idempotency: 'required', rateClass: 'WRITE' },
  { method: 'POST', path: '/v1/technician/visits/:visitId/release', surface: 'technician', action: 'jobs.visit.act', idempotency: 'required', rateClass: 'WRITE' },
];

export const jobsAdminEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/admin/v1/jobs', surface: 'admin', action: 'jobs.job.create_assisted', idempotency: 'required', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/jobs/:jobId/customer-confirmation', surface: 'admin', action: 'jobs.job.confirm_customer', idempotency: 'implicit', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/visits/:visitId/assignment', surface: 'admin', action: 'jobs.visit.assign_manual', idempotency: 'required', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/visits/:visitId/wait', surface: 'admin', action: 'jobs.visit.ops_wait', idempotency: 'required', rateClass: 'ADMIN' },
];

const json = (status: number, body?: unknown, headers: Record<string, string> = {}): JobsHttpResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, ...(body === undefined ? {} : { body }),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

function idempotencyKey(req: JobsHttpRequest): string {
  const key = req.headers['idempotency-key'];
  if (!key) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', code: 'REQUIRED' }] });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', code: 'INVALID' }] });
  }
  return key.toLowerCase();
}

function match(template: string, path: string): Record<string, string> | undefined {
  const t = template.split('/');
  const p = path.split('/');
  if (t.length !== p.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, seg] of t.entries()) {
    const actual = p[i] ?? '';
    if (seg.startsWith(':')) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actual)) return undefined;
      params[seg.slice(1)] = actual;
    } else if (seg !== actual) return undefined;
  }
  return params;
}

type Route = (req: JobsHttpRequest, params: Record<string, string>, actor: Actor) => Promise<JobsHttpResponse>;

function router(endpoints: readonly EndpointSpec[], routes: Record<string, Route>, authenticate: (req: JobsHttpRequest) => Promise<Actor>) {
  return async (req: JobsHttpRequest): Promise<JobsHttpResponse> => {
    try {
      for (const e of endpoints) {
        if (e.method !== req.method.toUpperCase()) continue;
        const params = match(e.path, req.path);
        const route = routes[`${e.method} ${e.path}`];
        if (params && route) return await route(req, params, await authenticate(req));
      }
      throw new AppError('NOT_FOUND');
    } catch (error) {
      const problem = toProblem(error, req.meta.requestId);
      const retry = error instanceof AppError && error.retryAfterSec !== undefined ? { 'retry-after': String(error.retryAfterSec) } : {};
      return { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...retry }, body: problem };
    }
  };
}

/** Customer and technician routes (`api` app). */
export function createJobsHttp(service: JobsService, authenticate: (req: JobsHttpRequest) => Promise<Actor>) {
  const p = (params: Record<string, string>, name: string) => params[name] ?? '';
  return router(jobsEndpoints, {
    'POST /v1/customer/jobs': async (req, _params, actor) => {
      const r = await service.bookJob(actor, parse(contracts.booking, req.body), idempotencyKey(req), req.meta);
      return json(r.status, r.body, r.replayed ? { 'idempotent-replay': 'true' } : {});
    },
    'GET /v1/customer/jobs/:jobId': async (_req, params, actor) => json(200, await service.getJob(actor, p(params, 'jobId'))),
    'GET /v1/customer/jobs/:jobId/cancellation-preview': async (_req, params, actor) => json(200, await service.cancellationPreview(actor, p(params, 'jobId'))),
    'POST /v1/customer/jobs/:jobId/cancel': async (req, params, actor) =>
      json(200, await service.cancelJob(actor, p(params, 'jobId'), parse(contracts.cancel, req.body), idempotencyKey(req), req.meta)),
    'POST /v1/customer/visits/:visitId/start-code': async (req, params, actor) => json(200, await service.issueStartCode(actor, p(params, 'visitId'), req.meta)),
    'GET /v1/technician/visits/:visitId': async (_req, params, actor) => json(200, await service.getAssignedVisit(actor, p(params, 'visitId'))),
    'POST /v1/technician/visits/:visitId/depart': async (req, params, actor) => {
      parse(contracts.depart, req.body);
      return json(200, await service.depart(actor, p(params, 'visitId'), idempotencyKey(req), req.meta));
    },
    'POST /v1/technician/visits/:visitId/arrive': async (req, params, actor) => {
      const body = parse(contracts.arrive, req.body);
      return json(200, await service.arrive(actor, p(params, 'visitId'), { startCode: body.startCode }, idempotencyKey(req), req.meta));
    },
    'POST /v1/technician/visits/:visitId/wait/start': async (req, params, actor) =>
      json(200, await service.startWait(actor, p(params, 'visitId'), parse(contracts.waitStart, req.body), idempotencyKey(req), req.meta)),
    'POST /v1/technician/visits/:visitId/release': async (req, params, actor) =>
      json(200, await service.release(actor, p(params, 'visitId'), parse(contracts.release, req.body), idempotencyKey(req), req.meta)),
  }, authenticate);
}

/** Ops routes (`admin-api` app). */
export function createJobsAdminHttp(service: JobsService, authenticate: (req: JobsHttpRequest) => Promise<Actor>) {
  const p = (params: Record<string, string>, name: string) => params[name] ?? '';
  return router(jobsAdminEndpoints, {
    'POST /admin/v1/jobs': async (req, _params, actor) => {
      const r = await service.bookAssisted(actor, parse(contracts.assistedBooking, req.body), idempotencyKey(req), req.meta);
      return json(r.status, r.body, r.replayed ? { 'idempotent-replay': 'true' } : {});
    },
    'POST /admin/v1/jobs/:jobId/customer-confirmation': async (req, params, actor) =>
      json(200, await service.confirmCustomerByCall(actor, p(params, 'jobId'), parse(contracts.customerConfirmation, req.body), req.meta)),
    'POST /admin/v1/visits/:visitId/assignment': async (req, params, actor) =>
      json(200, await service.assignManually(actor, p(params, 'visitId'), parse(contracts.manualAssignment, req.body), idempotencyKey(req), req.meta)),
    'POST /admin/v1/visits/:visitId/wait': async (req, params, actor) =>
      json(200, await service.opsConfirmWait(actor, p(params, 'visitId'), parse(contracts.opsWait, req.body), idempotencyKey(req), req.meta)),
  }, authenticate);
}
