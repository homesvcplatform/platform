// Backoffice application service (Phase 1 05 §2.5, §5.3–§5.4, §6, SR-03).
// - Login: the zero-trust proxy / company IdP asserts the admin (signed ES256 JWT). The assertion must carry a
//   phishing-resistant method (hardware key / passkey); SMS, TOTP and passwords are refused. In Phase 2 the IdP is
//   a test IdP (TE-02). Every request re-validates the proxy assertion AND the admin session.
// - Sessions: 10 h absolute, 30 min idle, one concurrent session per admin. Cookie `__Host-admin-sid` + CSRF token.
// - Passkeys: WebAuthn registration (first one only right after a fresh IdP login) and step-up assertions, required
//   for high-risk actions (≤ 5 min old).
// - Role grants: maker-checker (security.grant → security.grant.approve), three different people, payload-hash bound,
//   executed exactly once.
// - Change requests (Gate 4, ADR-025 #5): two-person approved configuration changes defined by other modules (city
//   service rules, city languages); the checker's step-up is bound like a grant decision; the owning module executes.
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import { newId, type Clock } from '@hsp/kernel';
import { appendAudit, beginIdempotent, completeIdempotent, IdempotencyConflict, withTransaction, type AuditEntry } from '@hsp/db';
import { AppError } from '@hsp/errors';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry, Scope } from '@hsp/policy';
import {
  constantTimeEqual, csrfToken, hmacSha256, JwtError, opaqueToken, RATE_RULES, sha256, tokenHash, verifyAssertion, verifyCsrfToken,
  verifyJwt, verifyRegistration, WebAuthnError, type RateLimiter,
} from '@hsp/security';
import {
  ADMIN_COOKIE, ADMIN_SESSION, APPROVAL_TTL_MS, FIRST_PASSKEY_WINDOW_MS, ADMIN_STEP_UP_MS, isPhishingResistant, isStepUpOperation,
  passkeyCeremoniesAllowed, type StepUpOperation,
} from '../domain/permissions.ts';
import { changeActionRegistry, type ChangeAction } from '../domain/changes.ts';
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
  /** Deployment environment: passkey ceremonies are refused outside local / test until the WebAuthn review passes. */
  readonly appEnv: string;
  /** Change-request actions wired by the app (ADR-025 #5). */
  readonly changeActions?: readonly ChangeAction[];
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

/** What a step-up authorises: one operation, and for a grant decision the approval request, its payload hash and the decision. */
interface StepUpBinding {
  readonly operation: StepUpOperation;
  readonly resourceId?: string | null;
  readonly payloadHash?: Buffer | null;
  readonly decision?: 'APPROVE' | 'REJECT' | null;
}
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
  readonly #changes: ReadonlyMap<string, ChangeAction>;

  constructor(deps: BackofficeDeps) {
    this.#d = deps;
    this.#changes = changeActionRegistry(deps.changeActions ?? []);
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
      // 05 §2.5: one concurrent session by default; a new login ends the old one. The admin row lock serialises
      // concurrent logins, so the second one sees (and revokes) the first one's session.
      await c.query(SQL.lockAdmin, [adminId]);
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

  #requirePasskeyCeremonies(): void {
    if (!passkeyCeremoniesAllowed(this.#d.appEnv)) {
      this.#d.logger.log('warn', 'security.passkeys_disabled', { appEnv: this.#d.appEnv });
      throw new AppError('FORBIDDEN');
    }
  }

  /** First passkey: only right after a fresh IdP login. Further passkeys: only with a step-up bound to this operation. */
  async beginPasskeyRegistration(actor: Actor, stepUpId?: string): Promise<{ challengeId: string; challenge: string; rpId: string }> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    this.#requirePasskeyCeremonies();
    const now = this.#now();
    return withTransaction(this.#d.pool, async (c) => {
      await c.query(SQL.lockAdmin, [actor.id]);
      const count = ((await c.query(SQL.credentialCount, [actor.id])).rows[0] as { n: number }).n;
      if (count === 0) {
        const s = (await c.query(SQL.sessionForAuth, [actor.sessionId])).rows[0] as Row;
        if (now.getTime() - (s['created_at'] as Date).getTime() > FIRST_PASSKEY_WINDOW_MS) throw new AppError('STEP_UP_REQUIRED');
        return this.#challenge(c, actor, { purpose: 'REGISTRATION', enrollmentMode: 'FIRST_PASSKEY' }, now);
      }
      await this.#useStepUp(c, actor, stepUpId, { operation: 'backoffice.passkey.register' }, now);
      return this.#challenge(c, actor, { purpose: 'REGISTRATION', enrollmentMode: 'STEP_UP' }, now);
    });
  }

  async #challenge(c: pg.ClientBase, actor: Actor,
    kind: { purpose: 'REGISTRATION'; enrollmentMode: 'FIRST_PASSKEY' | 'STEP_UP' } | ({ purpose: 'STEP_UP' } & StepUpBinding), now: Date) {
    const challenge = opaqueToken(32);
    const challengeId = newId();
    const b = kind.purpose === 'STEP_UP' ? kind : undefined;
    await c.query(SQL.insertChallenge, [challengeId, actor.id, actor.sessionId, kind.purpose, sha256(challenge), b?.operation ?? null,
      b?.resourceId ?? null, b?.payloadHash ?? null, b?.decision ?? null, kind.purpose === 'REGISTRATION' ? kind.enrollmentMode : null,
      new Date(now.getTime() + 5 * 60_000), now]);
    return { challengeId, challenge, rpId: this.#d.webauthn.rpId };
  }

  /**
   * Consumes a verified step-up for exactly this operation (and, for decisions, this approval request and payload hash).
   * Runs inside the transaction that performs the operation; the row lock makes concurrent reuse impossible.
   */
  async #useStepUp(c: pg.ClientBase, actor: Actor, stepUpId: string | undefined, binding: StepUpBinding, now: Date): Promise<void> {
    const resourceId = binding.resourceId ?? null;
    const payloadHash = binding.payloadHash ?? null;
    const decision = binding.decision ?? null;
    const s = stepUpId ? ((await c.query(SQL.lockChallenge, [stepUpId])).rows[0] as Row | undefined) : undefined;
    const storedHash = s?.['payload_hash'];
    const bound = s !== undefined && s['purpose'] === 'STEP_UP' && s['action'] === binding.operation && s['admin_user_id'] === actor.id
      && s['session_id'] === actor.sessionId && s['verified_at'] !== null && s['used_at'] === null
      && (s['verified_at'] as Date) <= now && now.getTime() - (s['verified_at'] as Date).getTime() <= ADMIN_STEP_UP_MS
      && (s['resource_id'] ?? null) === resourceId && (s['decision'] ?? null) === decision
      && (payloadHash === null ? storedHash === null : Buffer.isBuffer(storedHash) && constantTimeEqual(storedHash, payloadHash));
    if (!bound) throw new AppError('STEP_UP_REQUIRED');
    // The UPDATE re-checks every condition; exactly one row must change (defence in depth against drift or races).
    const used = await c.query(SQL.markUsed, [stepUpId, now, binding.operation, actor.id, actor.sessionId,
      new Date(now.getTime() - ADMIN_STEP_UP_MS), resourceId, payloadHash, decision]);
    if (used.rowCount !== 1) throw new AppError('STEP_UP_REQUIRED');
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
    this.#requirePasskeyCeremonies();
    const now = this.#now();
    await withTransaction(this.#d.pool, async (c) => {
      // Same lock as beginPasskeyRegistration: a challenge issued under the first-passkey exemption can only complete
      // while the admin still has no passkey (a stale or parallel first-passkey challenge can't add a second one).
      await c.query(SQL.lockAdmin, [actor.id]);
      const ch = await this.#consumeChallenge(c, actor, input.challengeId, 'REGISTRATION', now);
      if (!constantTimeEqual(sha256(input.challenge), ch['challenge_hash'] as Buffer)) throw new AppError('UNAUTHENTICATED');
      if (ch['enrollment_mode'] !== 'STEP_UP'
        && ((await c.query(SQL.credentialCount, [actor.id])).rows[0] as { n: number }).n > 0) throw new AppError('STEP_UP_REQUIRED');
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

  /**
   * Starts a step-up for one server-validated operation. For a grant decision the server binds the approval request and
   * its stored payload hash, after checking that the actor may decide it; the client only selects the operation.
   */
  async beginStepUp(actor: Actor, input: { operation: unknown; approvalRequestId?: string | undefined; decision?: 'APPROVE' | 'REJECT' | undefined }): Promise<{ challengeId: string; challenge: string; rpId: string }> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    this.#requirePasskeyCeremonies();
    const operation = input.operation;
    if (!isStepUpOperation(operation)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'operation', code: 'INVALID' }] });
    const now = this.#now();
    return withTransaction(this.#d.pool, async (c) => {
      if (operation === 'backoffice.passkey.register') {
        if (input.approvalRequestId !== undefined || input.decision !== undefined) throw new AppError('VALIDATION_FAILED');
        return this.#challenge(c, actor, { purpose: 'STEP_UP', operation }, now);
      }
      if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'decision', code: 'REQUIRED' }] });
      }
      if (operation === 'backoffice.change.decide') {
        const { request, action } = await this.#loadChange(c, input.approvalRequestId);
        this.#require(actor, 'backoffice.change.decide', this.#checkerResource(request, action));
        if (request['status'] !== 'PENDING' || (request['expires_at'] as Date) <= now) throw new AppError('INVALID_STATE');
        return this.#challenge(c, actor, { purpose: 'STEP_UP', operation, resourceId: request['id'] as string,
          payloadHash: request['payload_hash'] as Buffer, decision: input.decision }, now);
      }
      const a = input.approvalRequestId ? ((await c.query(SQL.approval, [input.approvalRequestId])).rows[0] as Row | undefined) : undefined;
      if (!a || a['action_type'] !== 'security.grant') throw new AppError('NOT_FOUND');
      this.#require(actor, 'backoffice.grant.decide', { granteeId: a['resource_id'] as string, requesterId: a['requested_by_admin_id'] as string });
      if (a['status'] !== 'PENDING' || (a['expires_at'] as Date) <= now) throw new AppError('INVALID_STATE');
      return this.#challenge(c, actor, { purpose: 'STEP_UP', operation, resourceId: a['id'] as string, payloadHash: a['payload_hash'] as Buffer,
        decision: input.decision }, now);
    });
  }

  /** WebAuthn assertion → a single-use authorisation for the bound operation, valid 5 minutes (`stepUpId`). */
  async finishStepUp(actor: Actor, input: { challengeId: string; challenge: string; credentialId: string; clientDataJSON: Buffer;
    authenticatorData: Buffer; signature: Buffer }, meta: AdminRequestMeta): Promise<{ stepUpId: string }> {
    this.#require(actor, 'backoffice.passkey.manage', {});
    this.#requirePasskeyCeremonies();
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
        await c.query(SQL.markVerified, [input.challengeId, now]);
      }
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'admin.step_up',
        resourceType: 'backoffice.admin_session', resourceId: actor.sessionId ?? null, outcome: verified ? 'SUCCESS' : 'FAILED',
        changeSummary: { stepUpAction: ch['action'] as string, decision: (ch['decision'] as string | null) ?? null } }, meta);
      return verified !== undefined;
    });
    if (!outcome) throw new AppError('UNAUTHENTICATED');
    return { stepUpId: input.challengeId };
  }

  // ---------------------------------------------------------------- role grants (maker-checker)

  /**
   * Maker step. `Idempotency-Key` required (04 §1.3): a retry with the same key and body replays the first response
   * (no second approval request); the same key with another body is refused.
   */
  async requestGrant(actor: Actor, input: GrantInput, idempotencyKey: string, meta: AdminRequestMeta): Promise<{ approvalRequestId: string; replayed: boolean }> {
    this.#require(actor, 'backoffice.grant.request', { granteeId: input.adminUserId, requesterId: actor.id ?? null });
    const now = this.#now();
    const payload = { adminUserId: input.adminUserId, roleCode: input.roleCode, scope: input.scope, expiresAt: input.expiresAt ?? null };
    const idem = { actorKey: `admin:${actor.id ?? ''}`, idemKey: idempotencyKey, endpoint: 'POST /admin/v1/grants', requestHash: sha256(canonicalJson(payload)), now };
    return withTransaction(this.#d.pool, async (c) => {
      let start;
      try {
        start = await beginIdempotent(c, idem);
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          throw error.reason === 'KEY_REUSED' ? new AppError('IDEMPOTENCY_KEY_REUSED') : new AppError('REQUEST_IN_PROGRESS', { retryAfterSec: 1 });
        }
        throw error;
      }
      if (start.kind === 'REPLAY') return { ...(start.body as { approvalRequestId: string }), replayed: true };
      const grantee = (await c.query(SQL.adminById, [input.adminUserId])).rows[0] as Row | undefined;
      const role = (await c.query(SQL.role, [input.roleCode])).rows[0] as Row | undefined;
      if (!grantee || grantee['status'] !== 'ACTIVE' || !role) throw new AppError('VALIDATION_FAILED');
      // Global-only roles (security admin, finance, auditor) can't be granted per city (also enforced by a DB trigger).
      if (role['global_only'] === true && input.scope.kind !== 'GLOBAL') {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'scope', code: 'GLOBAL_ONLY_ROLE' }] });
      }
      const id = newId();
      await c.query(SQL.insertApproval, [id, input.adminUserId, JSON.stringify(payload), sha256(canonicalJson(payload)), actor.id, now,
        new Date(now.getTime() + APPROVAL_TTL_MS)]);
      await completeIdempotent(c, idem, 202, { approvalRequestId: id });
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.requested',
        resourceType: 'backoffice.approval_request', resourceId: id, outcome: 'SUCCESS', changeSummary: { actionType: 'security.grant', role: input.roleCode } }, meta);
      return { approvalRequestId: id, replayed: false };
    });
  }

  /**
   * Checker decision. Needs the passkey step-up bound to this approval request and its payload hash (consumed here, once).
   * APPROVE executes the grant once, from the stored payload, after re-checking its hash.
   */
  async decideGrant(actor: Actor, approvalRequestId: string, decision: 'APPROVE' | 'REJECT', stepUpId: string | undefined, meta: AdminRequestMeta): Promise<void> {
    const now = this.#now();
    await withTransaction(this.#d.pool, async (c) => {
      const a = (await c.query(SQL.lockApproval, [approvalRequestId])).rows[0] as Row | undefined;
      if (!a || a['action_type'] !== 'security.grant') throw new AppError('NOT_FOUND');
      this.#require(actor, 'backoffice.grant.decide', { granteeId: a['resource_id'] as string, requesterId: a['requested_by_admin_id'] as string });
      if (a['status'] !== 'PENDING' || (a['expires_at'] as Date) <= now) throw new AppError('INVALID_STATE');
      const payload = a['payload'] as { adminUserId: string; roleCode: string; scope: Scope; expiresAt: string | null };
      if (!constantTimeEqual(sha256(canonicalJson(payload)), a['payload_hash'] as Buffer)) throw new AppError('INVALID_STATE');
      await this.#useStepUp(c, actor, stepUpId, { operation: 'security.grant.decide', resourceId: approvalRequestId,
        payloadHash: a['payload_hash'] as Buffer, decision }, now);
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

  // ---------------------------------------------------------------- change requests (two-person approved configuration)

  async #loadChange(c: pg.ClientBase | pg.Pool, id: string | undefined, lock = false): Promise<{ request: Row; action: ChangeAction }> {
    const request = id ? ((await c.query(lock ? SQL.lockApproval : SQL.changeRequest, [id])).rows[0] as Row | undefined) : undefined;
    const action = request ? this.#changes.get(request['action_type'] as string) : undefined;
    if (!request || !action) throw new AppError('NOT_FOUND');
    return { request, action };
  }

  #checkerResource(request: Row, action: ChangeAction) {
    return { permission: action.checkerPermission, cityId: action.cityOf(request['payload'] as Record<string, unknown>),
      requesterId: request['requested_by_admin_id'] as string };
  }

  /**
   * Maker step (ADR-025 #5). The owning module validates the input and returns the exact payload; the maker needs the
   * maker permission for the change's city. `Idempotency-Key` required: a retry replays the first response.
   */
  async requestChange(actor: Actor, input: { actionType: string; change: unknown }, idempotencyKey: string, meta: AdminRequestMeta):
    Promise<{ changeRequestId: string; replayed: boolean }> {
    const action = this.#changes.get(input.actionType);
    if (!action) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'actionType', code: 'UNKNOWN' }] });
    this.#require(actor, 'backoffice.change.request', { permission: action.makerPermission, cityId: undefined, requesterId: actor.id ?? null });
    const now = this.#now();
    const prepared = await action.prepare(input.change, now);
    this.#require(actor, 'backoffice.change.request', { permission: action.makerPermission, cityId: prepared.cityId, requesterId: actor.id ?? null });
    if (action.cityOf(prepared.payload) !== prepared.cityId) throw new AppError('INTERNAL');
    const hash = sha256(canonicalJson(prepared.payload));
    const idem = { actorKey: `admin:${actor.id ?? ''}`, idemKey: idempotencyKey, endpoint: 'POST /admin/v1/change-requests',
      requestHash: sha256(canonicalJson({ actionType: input.actionType, change: input.change })), now };
    return withTransaction(this.#d.pool, async (c) => {
      let start;
      try {
        start = await beginIdempotent(c, idem);
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          throw error.reason === 'KEY_REUSED' ? new AppError('IDEMPOTENCY_KEY_REUSED') : new AppError('REQUEST_IN_PROGRESS', { retryAfterSec: 1 });
        }
        throw error;
      }
      if (start.kind === 'REPLAY') return { ...(start.body as { changeRequestId: string }), replayed: true };
      const id = newId();
      await c.query(SQL.insertChangeRequest, [id, action.actionType, action.resourceType, prepared.resourceId, JSON.stringify(prepared.payload), hash,
        action.riskLevel, actor.id, now, action.checkerPermission, new Date(now.getTime() + APPROVAL_TTL_MS)]);
      await completeIdempotent(c, idem, 202, { changeRequestId: id });
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.requested',
        resourceType: 'backoffice.approval_request', resourceId: id, cityId: prepared.cityId, outcome: 'SUCCESS',
        changeSummary: { actionType: action.actionType, ...prepared.summary } }, meta);
      return { changeRequestId: id, replayed: false };
    });
  }

  /**
   * Checker decision. Needs the passkey step-up bound to this change request, its payload hash and the decision
   * (consumed here, once). APPROVE then executes the stored payload in the owning module; if that fails, the request
   * stays APPROVED and `executeChange` retries it.
   */
  async decideChange(actor: Actor, changeRequestId: string, decision: 'APPROVE' | 'REJECT', stepUpId: string | undefined, meta: AdminRequestMeta):
    Promise<{ status: 'EXECUTED' | 'APPROVED' | 'REJECTED' }> {
    const now = this.#now();
    const action = await withTransaction(this.#d.pool, async (c) => {
      const { request, action } = await this.#loadChange(c, changeRequestId, true);
      const resource = this.#checkerResource(request, action);
      this.#require(actor, 'backoffice.change.decide', resource);
      if (request['status'] !== 'PENDING' || (request['expires_at'] as Date) <= now) throw new AppError('INVALID_STATE');
      if (!constantTimeEqual(sha256(canonicalJson(request['payload'])), request['payload_hash'] as Buffer)) throw new AppError('INVALID_STATE');
      await this.#useStepUp(c, actor, stepUpId, { operation: 'backoffice.change.decide', resourceId: changeRequestId,
        payloadHash: request['payload_hash'] as Buffer, decision }, now);
      await c.query(SQL.decideApproval, [changeRequestId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actor.id, now]);
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.decided',
        resourceType: 'backoffice.approval_request', resourceId: changeRequestId, cityId: resource.cityId, outcome: 'SUCCESS',
        changeSummary: { decision, actionType: action.actionType } }, meta);
      return action;
    });
    if (decision === 'REJECT') return { status: 'REJECTED' };
    try {
      await this.#executeChange(actor, changeRequestId, action, meta);
      return { status: 'EXECUTED' };
    } catch (error) {
      this.#d.logger.log('warn', 'backoffice.change_execution_failed', { actionType: action.actionType,
        errorKind: error instanceof AppError ? error.code : 'INTERNAL' });
      return { status: 'APPROVED' };
    }
  }

  /** Retries the execution of an APPROVED change request (checker permission for its city, not the maker). */
  async executeChange(actor: Actor, changeRequestId: string, meta: AdminRequestMeta): Promise<{ status: 'EXECUTED' }> {
    const { request, action } = await this.#loadChange(this.#d.pool, changeRequestId);
    this.#require(actor, 'backoffice.change.decide', this.#checkerResource(request, action));
    if (request['status'] === 'EXECUTED') return { status: 'EXECUTED' };
    if (request['status'] !== 'APPROVED') throw new AppError('INVALID_STATE');
    await this.#executeChange(actor, changeRequestId, action, meta);
    return { status: 'EXECUTED' };
  }

  async #executeChange(actor: Actor, changeRequestId: string, action: ChangeAction, meta: AdminRequestMeta): Promise<void> {
    const request = (await this.#d.pool.query(SQL.changeRequest, [changeRequestId])).rows[0] as Row | undefined;
    if (!request || request['status'] !== 'APPROVED') throw new AppError('INVALID_STATE');
    const payload = request['payload'] as Record<string, unknown>;
    if (!constantTimeEqual(sha256(canonicalJson(payload)), request['payload_hash'] as Buffer)) throw new AppError('INVALID_STATE');
    // The owning module applies the stored payload in its own transaction (idempotent per change request id).
    await action.execute(changeRequestId, payload, { now: this.#now(), actorId: actor.id ?? '', requestId: meta.requestId });
    await withTransaction(this.#d.pool, async (c) => {
      const marked = await c.query(SQL.markExecuted, [changeRequestId]);
      if (marked.rowCount !== 1) return; // a concurrent retry marked it first
      await this.#audit(c, { actorType: 'ADMIN', actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null, action: 'approval.executed',
        resourceType: 'backoffice.approval_request', resourceId: changeRequestId, cityId: action.cityOf(payload), outcome: 'SUCCESS',
        changeSummary: { actionType: action.actionType } }, meta);
    });
  }
}
