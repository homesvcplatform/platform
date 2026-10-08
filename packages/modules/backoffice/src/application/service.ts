// Backoffice application service (Phase 1 05 §2.5, §5.3–§5.4, §6, SR-03).
// - Login: the zero-trust proxy / company IdP asserts the admin (signed ES256 JWT). The assertion must carry a
//   phishing-resistant method (hardware key / passkey); SMS, TOTP and passwords are refused. In Phase 2 the IdP is
//   a test IdP (TE-02). Every request re-validates the proxy assertion AND the admin session.
// - Sessions: 10 h absolute, 30 min idle, one concurrent session per admin. Cookie `__Host-admin-sid` + CSRF token.
// - Passkeys: WebAuthn registration (first one only right after a fresh IdP login) and step-up assertions, required
//   for high-risk actions (≤ 5 min old).
// - Role grants: maker-checker (security.grant → security.grant.approve), three different people, payload-hash bound,
//   executed exactly once.
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import { newId, type Clock } from '@hsp/kernel';
import { appendAudit, withTransaction, type AuditEntry } from '@hsp/db';
import { AppError } from '@hsp/errors';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry, Scope } from '@hsp/policy';
import {
  constantTimeEqual, csrfToken, hmacSha256, JwtError, opaqueToken, RATE_RULES, sha256, tokenHash, verifyAssertion, verifyCsrfToken,
  verifyJwt, verifyRegistration, WebAuthnError, type RateLimiter,
} from '@hsp/security';
import {
  ADMIN_COOKIE, ADMIN_SESSION, APPROVAL_TTL_MS, FIRST_PASSKEY_WINDOW_MS, ADMIN_STEP_UP_MS, isPhishingResistant,
} from '../domain/permissions.ts';
import { SQL } from '../infrastructure/sql.ts';

export interface IdpConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: ReadonlyMap<string, KeyObject>;
  /** Max assertion lifetime accepted (the proxy re-issues short assertions). */
  readonly maxLifetimeSec: number;
}

export interface BackofficeDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policies: PolicyRegistry;
  readonly rateLimiter: RateLimiter;
  readonly idp: IdpConfig;
  readonly webauthn: { readonly rpId: string; readonly origin: string };
  readonly csrfKey: Buffer;
  readonly requestHashKey: Buffer;
  readonly allowedOrigins: readonly string[];
}

export interface AdminRequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
}

export interface AdminRequest {
  readonly method: string;
  readonly proxyAssertion: string | undefined;
  readonly cookieHeader: string | undefined;
  readonly origin: string | undefined;
  readonly csrfHeader: string | undefined;
}

export interface GrantInput {
  readonly adminUserId: string;
  readonly roleCode: string;
  readonly scope: Scope;
  readonly expiresAt?: string | undefined;
}

type Row = Record<string, unknown>;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** Canonical JSON (sorted keys) for payload hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class BackofficeService {
  readonly #d: BackofficeDeps;

  constructor(deps: BackofficeDeps) {
    this.#d = deps;
  }

  #now(): Date {
    return this.#d.clock.now();
  }

  async #audit(c: pg.ClientBase, entry: AuditEntry, meta: AdminRequestMeta): Promise<void> {
    await appendAudit(c, { ...entry, requestId: meta.requestId, ipHash: hmacSha256(this.#d.requestHashKey, `ip|${meta.clientIp}`) });
  }

  /** Validates the proxy / IdP assertion: ES256, issuer, audience, lifetime, phishing-resistant method. */
  #verifyAssertion(assertion: string | undefined): { subject: string } {
    if (!assertion) throw new AppError('UNAUTHENTICATED');
    let claims;
    try {
      claims = verifyJwt(assertion, { keys: this.#d.idp.keys, issuer: this.#d.idp.issuer, audience: this.#d.idp.audience, now: this.#now(),
        maxLifetimeSec: this.#d.idp.maxLifetimeSec });
    } catch (error) {
      if (error instanceof JwtError) throw new AppError('UNAUTHENTICATED');
      throw error;
    }
    if (!isPhishingResistant(claims['amr'], claims['acr'])) {
      this.#d.logger.log('warn', 'security.admin_weak_mfa', { outcome: 'DENIED' });
      throw new AppError('UNAUTHENTICATED');
    }
    return { subject: claims.sub };
  }

  async login(proxyAssertion: string | undefined, meta: AdminRequestMeta): Promise<{ setCookie: string; csrfToken: string; sessionId: string; hasPasskey: boolean }> {
    const now = this.#now();
    const { subject } = this.#verifyAssertion(proxyAssertion);
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const admin = (await c.query(SQL.adminBySubject, [subject])).rows[0] as Row | undefined;
      if (!admin || admin['status'] !== 'ACTIVE') {
        await this.#audit(c, { actorType: 'ADMIN', actorId: (admin?.['id'] as string | undefined) ?? null, action: 'admin.login_failed',
          resourceType: 'backoffice.admin_user', resourceId: (admin?.['id'] as string | undefined) ?? null, outcome: 'FAILED',
          reasonCode: admin ? 'ADMIN_NOT_ACTIVE' : 'UNKNOWN_ADMIN' }, meta);
        return { error: new AppError('UNAUTHENTICATED') };
      }
      const adminId = admin['id'] as string;
      // 05 §2.5: one concurrent session by default; a new login ends the old one.
      const ended = (await c.query(SQL.revokeAdminSessions, [adminId, now, 'NEW_LOGIN'])).rows.length;
      const sessionId = newId();
      const secret = opaqueToken(32);
      await c.query(SQL.insertSession, [sessionId, adminId, tokenHash(secret), ['idp', 'hwk'],
        new Date(now.getTime() + ADMIN_SESSION.idleMs), new Date(now.getTime() + ADMIN_SESSION.absoluteMs), now]);
      const hasPasskey = ((await c.query(SQL.credentialCount, [adminId])).rows[0] as { n: number }).n > 0;
      await this.#audit(c, { actorType: 'ADMIN', actorId: adminId, actorSessionId: sessionId, action: 'admin.login_succeeded',
        resourceType: 'backoffice.admin_session', resourceId: sessionId, outcome: 'SUCCESS', changeSummary: { endedSessions: ended } }, meta);
      return { result: {
        setCookie: `${ADMIN_COOKIE}=${sessionId}.${secret}; Path=/; Max-Age=${ADMIN_SESSION.absoluteMs / 1000}; HttpOnly; Secure; SameSite=Strict`,
        csrfToken: csrfToken(this.#d.csrfKey, sessionId), sessionId, hasPasskey,
      } };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  /** Every admin request: proxy assertion + admin session (+ Origin and CSRF on mutations) → actor with live grants. */
  async authenticate(req: AdminRequest): Promise<Actor> {
    const now = this.#now();
    const { subject } = this.#verifyAssertion(req.proxyAssertion);
    const raw = (req.cookieHeader ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${ADMIN_COOKIE}=`));
    const m = raw ? COOKIE_VALUE.exec(raw.slice(ADMIN_COOKIE.length + 1)) : null;
    if (!m) throw new AppError('UNAUTHENTICATED');
    const [sessionId = '', secret = ''] = m.slice(1);
    const s = (await this.#d.pool.query(SQL.sessionForAuth, [sessionId])).rows[0] as Row | undefined;
    if (!s || !constantTimeEqual(tokenHash(secret), s['token_hash'] as Buffer) || s['revoked_at'] !== null
      || (s['idle_expires_at'] as Date) <= now || (s['absolute_expires_at'] as Date) <= now || s['admin_status'] !== 'ACTIVE'
      || s['idp_subject'] !== subject) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (!SAFE_METHODS.has(req.method.toUpperCase())
      && (!req.origin || !this.#d.allowedOrigins.includes(req.origin) || !verifyCsrfToken(this.#d.csrfKey, sessionId, req.csrfHeader))) {
      throw new AppError('CSRF_REJECTED');
    }
    const adminId = s['admin_user_id'] as string;
    const limited = await this.#d.rateLimiter.consume([{ rule: RATE_RULES.admin, key: adminId }], now);
    if (!limited.allowed) throw new AppError('RATE_LIMITED', { retryAfterSec: limited.retryAfterSec });
    await this.#d.pool.query(SQL.touchSession, [sessionId, now, new Date(now.getTime() + ADMIN_SESSION.idleMs)]);
    return {
      kind: 'ADMIN', id: adminId, sessionId, surface: 'ADMIN', permissions: await this.#authority(this.#d.pool, adminId, now),
      ...(s['step_up_at'] ? { stepUpAt: s['step_up_at'] as Date } : {}),
    };
  }

  /** Permissions from current grants (05 §3.1: resolved server-side per request, never from the client). */
  async #authority(q: pg.Pool | pg.ClientBase, adminId: string, now: Date): Promise<ReadonlyMap<string, readonly Scope[]>> {
    const rows = (await q.query(SQL.authority, [adminId, now])).rows as Row[];
    const map = new Map<string, Scope[]>();
    for (const r of rows) {
      const scope: Scope = r['scope_kind'] === 'GLOBAL' ? { kind: 'GLOBAL' } : { kind: 'CITIES', cityIds: r['city_ids'] as string[] };
      const list = map.get(r['permission'] as string) ?? [];
      list.push(scope);
      map.set(r['permission'] as string, list);
    }
    return map;
  }

  #require(actor: Actor, action: string, resource: unknown): void {
    const d = this.#d.policies.can(actor, action, resource, { now: this.#now() });
    if (!d.allow) throw new AppError(d.reason === 'STEP_UP_REQUIRED' ? 'STEP_UP_REQUIRED' : d.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN');
  }

  async logout(actor: Actor, meta: AdminRequestMeta): Promise<void> {
    this.#require(actor, 'backoffice.session.logout', {});
    await withTransaction(this.#d.pool, async (c) => {
      await c.query(SQL.revokeSession, [actor.sessionId, this.#now(), 'LOGOUT']);
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'admin.logout',
        resourceType: 'backoffice.admin_session', resourceId: actor.sessionId ?? null, outcome: 'SUCCESS' }, meta);
    });
  }

  // ---------------------------------------------------------------- passkeys (SR-03)

  async beginPasskeyRegistration(actor: Actor): Promise<{ challengeId: string; challenge: string; rpId: string }> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    const now = this.#now();
    return withTransaction(this.#d.pool, async (c) => {
      const count = ((await c.query(SQL.credentialCount, [actor.id])).rows[0] as { n: number }).n;
      const s = (await c.query(SQL.sessionForAuth, [actor.sessionId])).rows[0] as Row;
      const freshLogin = now.getTime() - (s['created_at'] as Date).getTime() <= FIRST_PASSKEY_WINDOW_MS;
      const steppedUp = actor.stepUpAt !== undefined && now.getTime() - actor.stepUpAt.getTime() <= ADMIN_STEP_UP_MS;
      // First passkey: only right after a fresh IdP login. Further passkeys: only with a recent passkey step-up.
      if (count === 0 ? !freshLogin : !steppedUp) throw new AppError('STEP_UP_REQUIRED');
      return this.#challenge(c, actor, 'REGISTRATION', null, now);
    });
  }

  async #challenge(c: pg.ClientBase, actor: Actor, purpose: 'REGISTRATION' | 'STEP_UP', action: string | null, now: Date) {
    const challenge = opaqueToken(32);
    const challengeId = newId();
    await c.query(SQL.insertChallenge, [challengeId, actor.id, actor.sessionId, purpose, sha256(challenge), action, new Date(now.getTime() + 5 * 60_000), now]);
    return { challengeId, challenge, rpId: this.#d.webauthn.rpId };
  }

  async #consumeChallenge(c: pg.ClientBase, actor: Actor, challengeId: string, purpose: 'REGISTRATION' | 'STEP_UP', now: Date): Promise<Row> {
    const ch = (await c.query(SQL.lockChallenge, [challengeId])).rows[0] as Row | undefined;
    if (!ch || ch['purpose'] !== purpose || ch['admin_user_id'] !== actor.id || ch['session_id'] !== actor.sessionId
      || ch['consumed_at'] !== null || (ch['expires_at'] as Date) <= now) throw new AppError('UNAUTHENTICATED');
    await c.query(SQL.consumeChallenge, [challengeId, now]);
    return ch;
  }

  async finishPasskeyRegistration(actor: Actor, input: { challengeId: string; challenge: string; clientDataJSON: Buffer; attestationObject: Buffer }, meta: AdminRequestMeta): Promise<void> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    const now = this.#now();
    await withTransaction(this.#d.pool, async (c) => {
      const ch = await this.#consumeChallenge(c, actor, input.challengeId, 'REGISTRATION', now);
      if (!constantTimeEqual(sha256(input.challenge), ch['challenge_hash'] as Buffer)) throw new AppError('UNAUTHENTICATED');
      let cred;
      try {
        cred = verifyRegistration({ clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject,
          expectedChallenge: input.challenge, expectedOrigin: this.#d.webauthn.origin, rpId: this.#d.webauthn.rpId });
      } catch (error) {
        if (error instanceof WebAuthnError) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'attestationObject', code: error.code }] });
        throw error;
      }
      await c.query(SQL.insertCredential, [newId(), actor.id, cred.credentialId, cred.publicKeySpki, cred.signCount, cred.backupEligible, now]);
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'admin.passkey_registered',
        resourceType: 'backoffice.admin_user', resourceId: actor.id ?? null, outcome: 'SUCCESS' }, meta);
    });
    this.#d.logger.log('warn', 'security.admin_passkey_added', { outcome: 'SUCCESS' });
  }

  async beginStepUp(actor: Actor, action: string): Promise<{ challengeId: string; challenge: string; rpId: string }> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/.test(action)) throw new AppError('VALIDATION_FAILED');
    return withTransaction(this.#d.pool, (c) => this.#challenge(c, actor, 'STEP_UP', action, this.#now()));
  }

  /** WebAuthn assertion → session step-up timestamp (valid for high-risk actions for 5 minutes). */
  async finishStepUp(actor: Actor, input: { challengeId: string; challenge: string; credentialId: string; clientDataJSON: Buffer;
    authenticatorData: Buffer; signature: Buffer }, meta: AdminRequestMeta): Promise<void> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    const now = this.#now();
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const ch = await this.#consumeChallenge(c, actor, input.challengeId, 'STEP_UP', now);
      const cred = (await c.query(SQL.lockCredential, [input.credentialId, actor.id])).rows[0] as Row | undefined;
      let verified: { signCount: number } | undefined;
      if (cred && constantTimeEqual(sha256(input.challenge), ch['challenge_hash'] as Buffer)) {
        try {
          verified = verifyAssertion({ clientDataJSON: input.clientDataJSON, authenticatorData: input.authenticatorData, signature: input.signature,
            expectedChallenge: input.challenge, expectedOrigin: this.#d.webauthn.origin, rpId: this.#d.webauthn.rpId,
            publicKeySpki: cred['public_key_spki'] as Buffer, storedSignCount: Number(cred['sign_count']) });
        } catch (error) {
          if (!(error instanceof WebAuthnError)) throw error;
        }
      }
      if (cred && verified) {
        await c.query(SQL.updateCredential, [cred['id'], verified.signCount, now]);
        await c.query(SQL.setStepUp, [actor.sessionId, now]);
      }
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'admin.step_up',
        resourceType: 'backoffice.admin_session', resourceId: actor.sessionId ?? null, outcome: verified ? 'SUCCESS' : 'FAILED',
        changeSummary: { stepUpAction: ch['action'] as string } }, meta);
      return verified !== undefined;
    });
    if (!outcome) throw new AppError('UNAUTHENTICATED');
  }

  // ---------------------------------------------------------------- role grants (maker-checker)

  async requestGrant(actor: Actor, input: GrantInput, meta: AdminRequestMeta): Promise<{ approvalRequestId: string }> {
    this.#require(actor, 'backoffice.grant.request', { granteeId: input.adminUserId, requesterId: actor.id ?? null });
    const now = this.#now();
    const payload = { adminUserId: input.adminUserId, roleCode: input.roleCode, scope: input.scope, expiresAt: input.expiresAt ?? null };
    return withTransaction(this.#d.pool, async (c) => {
      const grantee = (await c.query(SQL.adminById, [input.adminUserId])).rows[0] as Row | undefined;
      if (!grantee || grantee['status'] !== 'ACTIVE' || (await c.query(SQL.roleExists, [input.roleCode])).rows.length === 0) {
        throw new AppError('VALIDATION_FAILED');
      }
      const id = newId();
      await c.query(SQL.insertApproval, [id, input.adminUserId, JSON.stringify(payload), sha256(canonicalJson(payload)), actor.id, now,
        new Date(now.getTime() + APPROVAL_TTL_MS)]);
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.requested',
        resourceType: 'backoffice.approval_request', resourceId: id, outcome: 'SUCCESS', changeSummary: { actionType: 'security.grant', role: input.roleCode } }, meta);
      return { approvalRequestId: id };
    });
  }

  /** Checker decision. APPROVE executes the grant once, from the stored payload, after re-checking its hash. */
  async decideGrant(actor: Actor, approvalRequestId: string, decision: 'APPROVE' | 'REJECT', meta: AdminRequestMeta): Promise<void> {
    const now = this.#now();
    await withTransaction(this.#d.pool, async (c) => {
      const a = (await c.query(SQL.lockApproval, [approvalRequestId])).rows[0] as Row | undefined;
      if (!a || a['action_type'] !== 'security.grant') throw new AppError('NOT_FOUND');
      this.#require(actor, 'backoffice.grant.decide', { granteeId: a['resource_id'] as string, requesterId: a['requested_by_admin_id'] as string });
      if (a['status'] !== 'PENDING' || (a['expires_at'] as Date) <= now) throw new AppError('INVALID_STATE');
      const payload = a['payload'] as { adminUserId: string; roleCode: string; scope: Scope; expiresAt: string | null };
      if (!constantTimeEqual(sha256(canonicalJson(payload)), a['payload_hash'] as Buffer)) throw new AppError('INVALID_STATE');
      await c.query(SQL.decideApproval, [approvalRequestId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actor.id, now]);
      if (decision === 'APPROVE') {
        await c.query(SQL.insertGrant, [newId(), payload.adminUserId, payload.roleCode, payload.scope.kind,
          payload.scope.kind === 'CITIES' ? payload.scope.cityIds : [], a['requested_by_admin_id'], actor.id, approvalRequestId,
          payload.expiresAt === null ? null : new Date(payload.expiresAt), now]);
        await c.query(SQL.markExecuted, [approvalRequestId]);
      }
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.decided',
        resourceType: 'backoffice.approval_request', resourceId: approvalRequestId, outcome: 'SUCCESS',
        changeSummary: { decision, role: payload.roleCode } }, meta);
    });
    if (decision === 'APPROVE') this.#d.logger.log('warn', 'security.admin_grant_changed', { outcome: 'EXECUTED' });
  }
}
