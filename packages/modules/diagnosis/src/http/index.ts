// HTTP surface of module "diagnosis" (Phase 1 04 §10 diagnosis, §11 quotes & approval, SR-05 links; Gate 6 subset).
// Framework-neutral handlers (ADR-024 #1; no HTTP library is chosen and nothing is served yet): the app resolves the
// actor and passes it in through `authenticate`. Link handlers take no session: the link token (fragment, POSTed in the
// body) plus the OTP to the registered number are the credentials. No CORS headers are ever produced.
import { diagnosis as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { Actor, EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { DiagnosisService, RequestMeta } from '../application/service.ts';

export interface DiagnosisHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly meta: RequestMeta;
}

export interface DiagnosisHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

const PREVIEW_IDEMPOTENCY = { none: 'pure server-side pricing; persists nothing' } as const;

export const diagnosisEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/v1/technician/visits/:visitId/diagnoses', surface: 'technician', action: 'diagnosis.diagnosis.write', idempotency: 'required', rateClass: 'WRITE' },
  { method: 'PUT', path: '/v1/technician/diagnoses/:diagnosisId', surface: 'technician', action: 'diagnosis.diagnosis.write', idempotency: 'required', rateClass: 'WRITE' },
  { method: 'POST', path: '/v1/technician/diagnoses/:diagnosisId/quote-preview', surface: 'technician', action: 'diagnosis.diagnosis.write', idempotency: PREVIEW_IDEMPOTENCY, rateClass: 'READ' },
  { method: 'POST', path: '/v1/technician/diagnoses/:diagnosisId/submit', surface: 'technician', action: 'diagnosis.diagnosis.write', idempotency: 'required', rateClass: 'CRITICAL' },
  { method: 'GET', path: '/v1/technician/visits/:visitId/quote', surface: 'technician', action: 'diagnosis.quote.read_technician', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'GET', path: '/v1/customer/jobs/:jobId/quote', surface: 'customer', action: 'diagnosis.quote.read_customer', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'POST', path: '/v1/customer/quote-versions/:quoteVersionId/approve', surface: 'customer', action: 'diagnosis.quote.decide', idempotency: 'required', rateClass: 'CRITICAL' },
  { method: 'POST', path: '/v1/customer/quote-versions/:quoteVersionId/reject', surface: 'customer', action: 'diagnosis.quote.decide', idempotency: 'required', rateClass: 'CRITICAL' },
];

export const diagnosisLinkEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/v1/links/quotes/view', surface: 'public', action: 'diagnosis.link.use', idempotency: 'implicit', rateClass: 'LINK' },
  { method: 'POST', path: '/v1/links/quotes/otp', surface: 'public', action: 'diagnosis.link.use', idempotency: { none: 'sends a fresh code; per-phone OTP limits apply' }, rateClass: 'AUTH_OTP_SEND' },
  { method: 'POST', path: '/v1/links/quotes/decision', surface: 'public', action: 'diagnosis.link.use', idempotency: 'implicit', rateClass: 'CRITICAL' },
];

export const diagnosisAdminEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/admin/v1/visits/:visitId/diagnoses', surface: 'admin', action: 'diagnosis.ops_capture', idempotency: 'required', rateClass: 'ADMIN' },
  { method: 'PUT', path: '/admin/v1/diagnoses/:diagnosisId', surface: 'admin', action: 'diagnosis.ops_capture', idempotency: 'required', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/diagnoses/:diagnosisId/quote-preview', surface: 'admin', action: 'diagnosis.ops_capture', idempotency: PREVIEW_IDEMPOTENCY, rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/diagnoses/:diagnosisId/submit', surface: 'admin', action: 'diagnosis.ops_capture', idempotency: 'required', rateClass: 'ADMIN' },
];

const json = (status: number, body?: unknown, headers: Record<string, string> = {}): DiagnosisHttpResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, ...(body === undefined ? {} : { body }),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

function idempotencyKey(req: DiagnosisHttpRequest): string {
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

type Route = (req: DiagnosisHttpRequest, params: Record<string, string>, actor: Actor) => Promise<DiagnosisHttpResponse>;

function router(endpoints: readonly EndpointSpec[], routes: Record<string, Route>, authenticate: (req: DiagnosisHttpRequest) => Promise<Actor>,
  extraHeaders: Record<string, string> = {}) {
  return async (req: DiagnosisHttpRequest): Promise<DiagnosisHttpResponse> => {
    try {
      for (const e of endpoints) {
        if (e.method !== req.method.toUpperCase()) continue;
        const params = match(e.path, req.path);
        const route = routes[`${e.method} ${e.path}`];
        if (params && route) {
          const r = await route(req, params, await authenticate(req));
          return { ...r, headers: { ...r.headers, ...extraHeaders } };
        }
      }
      throw new AppError('NOT_FOUND');
    } catch (error) {
      const problem = toProblem(error, req.meta.requestId);
      const retry = error instanceof AppError && error.retryAfterSec !== undefined ? { 'retry-after': String(error.retryAfterSec) } : {};
      return { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...retry, ...extraHeaders }, body: problem };
    }
  };
}

const param = (params: Record<string, string>, name: string) => params[name] ?? '';

/** Technician and customer routes (`api` app). */
export function createDiagnosisHttp(service: DiagnosisService, authenticate: (req: DiagnosisHttpRequest) => Promise<Actor>) {
  return router(diagnosisEndpoints, {
    'POST /v1/technician/visits/:visitId/diagnoses': async (req, params, actor) =>
      json(201, await service.startDiagnosis(actor, param(params, 'visitId'), parse(contracts.startDiagnosis, req.body), idempotencyKey(req), req.meta)),
    'PUT /v1/technician/diagnoses/:diagnosisId': async (req, params, actor) =>
      json(200, await service.updateDraft(actor, param(params, 'diagnosisId'), parse(contracts.diagnosisDraft, req.body), idempotencyKey(req), req.meta)),
    'POST /v1/technician/diagnoses/:diagnosisId/quote-preview': async (_req, params, actor) => json(200, await service.previewQuote(actor, param(params, 'diagnosisId'))),
    'POST /v1/technician/diagnoses/:diagnosisId/submit': async (req, params, actor) =>
      json(200, await service.submitDiagnosis(actor, param(params, 'diagnosisId'), parse(contracts.submitDiagnosis, req.body), idempotencyKey(req), req.meta)),
    'GET /v1/technician/visits/:visitId/quote': async (_req, params, actor) => json(200, await service.getTechnicianQuote(actor, param(params, 'visitId'))),
    'GET /v1/customer/jobs/:jobId/quote': async (_req, params, actor) => json(200, await service.getCustomerQuote(actor, param(params, 'jobId'))),
    'POST /v1/customer/quote-versions/:quoteVersionId/approve': async (req, params, actor) =>
      json(200, await service.approveQuote(actor, param(params, 'quoteVersionId'), parse(contracts.approveQuote, req.body), idempotencyKey(req), req.meta)),
    'POST /v1/customer/quote-versions/:quoteVersionId/reject': async (req, params, actor) =>
      json(200, await service.rejectQuote(actor, param(params, 'quoteVersionId'), parse(contracts.rejectQuote, req.body), idempotencyKey(req), req.meta)),
  }, authenticate);
}

/** Signed-link routes (SR-05): no session; `Referrer-Policy: no-referrer`; preview agents get a generic page. */
export function createDiagnosisLinkHttp(service: DiagnosisService) {
  const anonymous = async (): Promise<Actor> => ({ kind: 'ANONYMOUS' });
  return router(diagnosisLinkEndpoints, {
    'POST /v1/links/quotes/view': async (req) => json(200, await service.viewLink(parse(contracts.linkView, req.body), req.headers['user-agent'])),
    'POST /v1/links/quotes/otp': async (req) => json(200, await service.requestLinkOtp(parse(contracts.linkOtp, req.body), req.meta)),
    'POST /v1/links/quotes/decision': async (req) => json(200, await service.linkDecision(parse(contracts.linkDecision, req.body), req.meta)),
  }, anonymous, { 'referrer-policy': 'no-referrer' });
}

/** Ops-desk capture routes (`admin-api` app). */
export function createDiagnosisAdminHttp(service: DiagnosisService, authenticate: (req: DiagnosisHttpRequest) => Promise<Actor>) {
  return router(diagnosisAdminEndpoints, {
    'POST /admin/v1/visits/:visitId/diagnoses': async (req, params, actor) =>
      json(201, await service.opsStartDiagnosis(actor, param(params, 'visitId'), parse(contracts.opsStartDiagnosis, req.body), idempotencyKey(req), req.meta)),
    'PUT /admin/v1/diagnoses/:diagnosisId': async (req, params, actor) =>
      json(200, await service.opsUpdateDraft(actor, param(params, 'diagnosisId'), parse(contracts.diagnosisDraft, req.body), idempotencyKey(req), req.meta)),
    'POST /admin/v1/diagnoses/:diagnosisId/quote-preview': async (_req, params, actor) => json(200, await service.opsPreviewQuote(actor, param(params, 'diagnosisId'))),
    'POST /admin/v1/diagnoses/:diagnosisId/submit': async (req, params, actor) =>
      json(200, await service.opsSubmitDiagnosis(actor, param(params, 'diagnosisId'), parse(contracts.submitDiagnosis, req.body), idempotencyKey(req), req.meta)),
  }, authenticate);
}
