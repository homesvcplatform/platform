// HTTP surface of module "identity" (Phase 1 04 §3), registered by the `api` app. Framework-neutral handlers: the app's
// HTTP framework adapts its request into `HttpRequest` (with the client IP already resolved by `resolveClientIp`, SR-10)
// and writes `HttpResponse` back. No CORS headers are ever produced (G-6 / SR-11).
import { randomUUID } from 'node:crypto';
import { auth as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { Actor, EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { IdentityService, RequestMeta } from '../application/service.ts';

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly meta: RequestMeta;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const identityEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/v1/auth/otp/request', surface: 'public', action: 'identity.otp.request', idempotency: { none: 'per-phone cooldown makes retries harmless (04 §3)' }, rateClass: 'AUTH_OTP_SEND' },
  { method: 'POST', path: '/v1/auth/otp/verify', surface: 'public', action: 'identity.otp.verify', idempotency: 'implicit', rateClass: 'AUTH_OTP_VERIFY' },
  { method: 'POST', path: '/v1/auth/token/refresh', surface: 'technician', action: 'identity.token.refresh', idempotency: 'implicit', rateClass: 'REFRESH' },
  { method: 'POST', path: '/v1/auth/logout', surface: 'session', action: 'identity.logout', idempotency: 'implicit', rateClass: 'WRITE' },
  { method: 'GET', path: '/v1/auth/sessions', surface: 'session', action: 'identity.session.list', idempotency: 'implicit', rateClass: 'READ' },
  { method: 'DELETE', path: '/v1/auth/sessions/:sessionId', surface: 'session', action: 'identity.session.revoke', idempotency: 'implicit', rateClass: 'WRITE' },
  { method: 'POST', path: '/v1/auth/step-up/otp', surface: 'session', action: 'identity.step_up', idempotency: { none: 'per-phone cooldown makes retries harmless' }, rateClass: 'AUTH_OTP_SEND' },
  { method: 'POST', path: '/v1/auth/step-up', surface: 'session', action: 'identity.step_up', idempotency: 'implicit', rateClass: 'AUTH_OTP_VERIFY' },
];

const json = (status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, ...(body === undefined ? {} : { body }),
});

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

function match(template: string, path: string): Record<string, string> | undefined {
  const t = template.split('/');
  const p = path.split('/');
  if (t.length !== p.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, seg] of t.entries()) {
    const actual = p[i] ?? '';
    if (seg.startsWith(':')) {
      if (!/^[0-9a-f-]{36}$/.test(actual)) return undefined;
      params[seg.slice(1)] = actual;
    } else if (seg !== actual) return undefined;
  }
  return params;
}

export function createIdentityHttp(service: IdentityService): (req: HttpRequest) => Promise<HttpResponse> {
  const authenticate = async (req: HttpRequest): Promise<Actor> => {
    const authz = req.headers['authorization'];
    if (authz !== undefined) {
      const m = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authz);
      if (!m?.[1]) throw new AppError('UNAUTHENTICATED');
      return service.authenticateAccessToken(m[1]);
    }
    return service.authenticateWebRequest({ method: req.method, cookieHeader: req.headers['cookie'], origin: req.headers['origin'], csrfHeader: req.headers['x-csrf-token'] });
  };

  const routes: Record<string, (req: HttpRequest, params: Record<string, string>) => Promise<HttpResponse>> = {
    'POST /v1/auth/otp/request': async (req) => {
      const body = parse(contracts.otpRequest, req.body);
      return json(202, await service.requestLoginOtp({ phone: body.phone, locale: body.locale, channel: body.channel, integrityToken: body.integrityToken }, req.meta));
    },
    'POST /v1/auth/otp/verify': async (req) => {
      const body = parse(contracts.otpVerify, req.body);
      const r = await service.verifyLoginOtp(body, req.meta);
      if (r.kind === 'APP') {
        return json(200, { accessToken: r.accessToken, refreshToken: r.refreshToken, deviceId: r.deviceId,
          session: { id: r.sessionId, absoluteExpiresAt: r.absoluteExpiresAt.toISOString() }, user: { isNew: r.isNew } });
      }
      // SR-02: browser surfaces get only the HttpOnly cookie; no token ever appears in the body.
      return json(200, { csrfToken: r.csrfToken, user: { isNew: r.isNew }, ...(r.nextStep ? { nextStep: r.nextStep } : {}) }, { 'set-cookie': r.setCookie });
    },
    'POST /v1/auth/token/refresh': async (req) => json(200, await service.refresh(parse(contracts.tokenRefresh, req.body), req.meta)),
    'POST /v1/auth/logout': async (req) => {
      await service.logout(await authenticate(req), req.meta);
      return json(204, undefined, { 'set-cookie': '__Host-sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    },
    'GET /v1/auth/sessions': async (req) => json(200, { items: await service.listSessions(await authenticate(req)) }),
    'DELETE /v1/auth/sessions/:sessionId': async (req, params) => {
      await service.revokeSession(await authenticate(req), params['sessionId'] ?? '', req.meta);
      return json(204);
    },
    'POST /v1/auth/step-up/otp': async (req) => json(202, await service.requestStepUpOtp(await authenticate(req), req.meta)),
    'POST /v1/auth/step-up': async (req) => {
      await service.completeStepUp(await authenticate(req), parse(contracts.stepUpComplete, req.body), req.meta);
      return json(204);
    },
  };

  return async (req) => {
    try {
      for (const e of identityEndpoints) {
        if (e.method !== req.method.toUpperCase()) continue;
        const params = match(e.path, req.path);
        const handler = routes[`${e.method} ${e.path}`];
        if (params && handler) return await handler(req, params);
      }
      throw new AppError('NOT_FOUND');
    } catch (error) {
      const problem = toProblem(error, req.meta.requestId || randomUUID());
      const retry = error instanceof AppError && error.retryAfterSec !== undefined ? { 'retry-after': String(error.retryAfterSec) } : {};
      return { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...retry }, body: problem };
    }
  };
}
