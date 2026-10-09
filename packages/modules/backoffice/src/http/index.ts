// HTTP surface of module "backoffice" (admin realm, /admin/v1), registered by the `admin-api` app behind the
// zero-trust proxy. Framework-neutral handlers; no CORS headers are ever produced (G-6 / SR-11).
import { admin as contracts } from '@hsp/contracts';
import { AppError, toProblem } from '@hsp/errors';
import type { EndpointSpec } from '@hsp/policy';
import type { z } from 'zod';
import type { AdminRequestMeta, BackofficeService } from '../application/service.ts';

export const PROXY_ASSERTION_HEADER = 'x-proxy-assertion';

export interface AdminHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly meta: AdminRequestMeta;
}

export interface AdminHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const backofficeEndpoints: readonly EndpointSpec[] = [
  { method: 'POST', path: '/admin/v1/session', surface: 'admin', action: 'backoffice.login', idempotency: 'implicit', rateClass: 'ADMIN' },
  { method: 'DELETE', path: '/admin/v1/session', surface: 'admin', action: 'backoffice.session.logout', idempotency: 'implicit', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/passkeys/registration-options', surface: 'admin', action: 'backoffice.passkey.manage', idempotency: { none: 'issues a fresh single-use challenge' }, rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/passkeys', surface: 'admin', action: 'backoffice.passkey.manage', idempotency: 'implicit', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/step-up/options', surface: 'admin', action: 'backoffice.passkey.manage', idempotency: { none: 'issues a fresh single-use challenge' }, rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/step-up', surface: 'admin', action: 'backoffice.passkey.manage', idempotency: 'implicit', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/grants', surface: 'admin', action: 'backoffice.grant.request', idempotency: 'required', rateClass: 'ADMIN' },
  { method: 'POST', path: '/admin/v1/approvals/:approvalRequestId/decision', surface: 'admin', action: 'backoffice.grant.decide', idempotency: 'implicit', rateClass: 'ADMIN' },
];

const json = (status: number, body?: unknown, headers: Record<string, string> = {}): AdminHttpResponse => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, ...(body === undefined ? {} : { body }),
});

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) });
  return r.data;
}

const b = (s: string) => Buffer.from(s, 'base64url');

/** 04 §1.3: endpoints declared `required` need an `Idempotency-Key` UUID header. */
function idempotencyKey(req: AdminHttpRequest): string {
  const key = req.headers['idempotency-key'];
  if (!key) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', code: 'REQUIRED' }] });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', code: 'INVALID' }] });
  }
  return key.toLowerCase();
}

/** The challenge the authenticator signed (checked again against the stored hash and inside verification). */
function challengeOf(clientDataJSON: string): string {
  try {
    const value: unknown = JSON.parse(b(clientDataJSON).toString('utf8'));
    const challenge = (value as { challenge?: unknown } | null)?.challenge;
    if (typeof challenge === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return challenge;
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'clientDataJSON', code: 'INVALID' }] });
}

export function createBackofficeHttp(service: BackofficeService): (req: AdminHttpRequest) => Promise<AdminHttpResponse> {
  const actorOf = (req: AdminHttpRequest) => service.authenticate({
    method: req.method, proxyAssertion: req.headers[PROXY_ASSERTION_HEADER], cookieHeader: req.headers['cookie'],
    origin: req.headers['origin'], csrfHeader: req.headers['x-csrf-token'],
  });

  return async (req) => {
    try {
      const route = `${req.method.toUpperCase()} ${req.path.replace(/\/[0-9a-f-]{36}\//, '/:approvalRequestId/')}`;
      switch (route) {
        case 'POST /admin/v1/session': {
          const r = await service.login(req.headers[PROXY_ASSERTION_HEADER], req.meta);
          return json(200, { csrfToken: r.csrfToken, hasPasskey: r.hasPasskey }, { 'set-cookie': r.setCookie });
        }
        case 'DELETE /admin/v1/session':
          await service.logout(await actorOf(req), req.meta);
          return json(204);
        case 'POST /admin/v1/passkeys/registration-options': {
          const actor = await actorOf(req);
          const body = parse(contracts.passkeyRegistrationOptions, req.body ?? {});
          return json(200, await service.beginPasskeyRegistration(actor, body.stepUpId));
        }
        case 'POST /admin/v1/passkeys': {
          const body = parse(contracts.passkeyRegistrationFinish, req.body);
          await service.finishPasskeyRegistration(await actorOf(req), { challengeId: body.challengeId, challenge: challengeOf(body.clientDataJSON),
            clientDataJSON: b(body.clientDataJSON), attestationObject: b(body.attestationObject) }, req.meta);
          return json(201);
        }
        case 'POST /admin/v1/step-up/options': {
          const actor = await actorOf(req);
          const body = parse(contracts.stepUpOptions, req.body);
          return json(200, await service.beginStepUp(actor, { operation: body.operation, approvalRequestId: body.approvalRequestId, decision: body.decision }));
        }
        case 'POST /admin/v1/step-up': {
          const body = parse(contracts.passkeyAssertion, req.body);
          const r = await service.finishStepUp(await actorOf(req), { challengeId: body.challengeId, challenge: challengeOf(body.clientDataJSON),
            credentialId: body.credentialId, clientDataJSON: b(body.clientDataJSON), authenticatorData: b(body.authenticatorData),
            signature: b(body.signature) }, req.meta);
          return json(200, r);
        }
        case 'POST /admin/v1/grants': {
          const actor = await actorOf(req);
          const key = idempotencyKey(req);
          const body = parse(contracts.grantRequest, req.body);
          const r = await service.requestGrant(actor, body, key, req.meta);
          return json(202, { approvalRequestId: r.approvalRequestId }, r.replayed ? { 'idempotent-replay': 'true' } : {});
        }
        case 'POST /admin/v1/approvals/:approvalRequestId/decision': {
          const id = /\/admin\/v1\/approvals\/([0-9a-f-]{36})\/decision$/.exec(req.path)?.[1] ?? '';
          const body = parse(contracts.approvalDecision, req.body);
          await service.decideGrant(await actorOf(req), id, body.decision, body.stepUpId, req.meta);
          return json(204);
        }
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
