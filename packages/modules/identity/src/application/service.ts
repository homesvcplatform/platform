// Identity application service (Phase 1 05 §2–§4 / §10, 04 §3, errata G-6, SR-02, SR-06, SR-10, X-14).
// Transactions: one per command; the audit row is the last statement. Failures that must persist (OTP attempt counts,
// refresh-reuse revocations) are returned from the transaction and thrown after COMMIT.
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import { newId, type Clock } from '@hsp/kernel';
import { appendAudit, withTransaction, type AuditEntry } from '@hsp/db';
import { AppError } from '@hsp/errors';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry } from '@hsp/policy';
import {
  blindIndex, constantTimeEqual, createFieldCrypto, csrfToken, hashSecret, hmacSha256, JwtError, needsRehash, numericCode,
  opaqueToken, otpCodeHmac, RATE_RULES, signJwt, tokenHash, verifyCsrfToken, verifyJwt, verifySecret,
  type DekCache, type EncryptionContext, type FieldCrypto, type JwtSigner, type KeyManagementPort, type RateLimiter,
  type StoredSubjectKey, type SubjectKeyStore,
} from '@hsp/security';
import {
  ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_TTL_SEC, actorKindFor, IVR_PIN, maskPhone, OTP, phoneAllowed, pinRejectionReason,
  REFRESH_RETRY_GRACE_MS, SESSION_COOKIE, SESSION_POLICY, sessionCookieHeader, surfaceUsesBearerTokens,
  type PhonePolicy, type Surface,
} from '../domain/rules.ts';
import { SQL } from '../infrastructure/sql.ts';
import type { BotVerifier, OtpSender, SurfaceEligibility } from '../public/ports.ts';

export interface IdentityKeys {
  readonly otpPepper: Buffer;
  readonly blindIndexPepper: Buffer;
  readonly refreshRotationKey: Buffer;
  readonly csrfKey: Buffer;
  readonly requestHashKey: Buffer;
}

export interface IdentityDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly kms: KeyManagementPort;
  readonly dekCache: DekCache;
  readonly keys: IdentityKeys;
  readonly tokenSigner: JwtSigner;
  readonly tokenVerificationKeys: ReadonlyMap<string, KeyObject>;
  readonly issuer: string;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly otpSender: OtpSender;
  readonly eligibility: SurfaceEligibility;
  readonly botVerifier: BotVerifier;
  readonly policies: PolicyRegistry;
  readonly phonePolicy: PhonePolicy;
  readonly allowedWebOrigins: readonly string[];
  /** Fixed-code test numbers (non-production only, reserved range only: enforced at construction). */
  readonly fixedOtpCodes?: ReadonlyMap<string, string>;
}

/** Resolved at the edge: the client IP comes from `resolveClientIp` (SR-10), never from X-Forwarded-For. */
export interface RequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
  readonly deviceRef?: string;
}

export type LoginResult =
  | { readonly kind: 'APP'; readonly accessToken: string; readonly refreshToken: string; readonly sessionId: string;
      readonly absoluteExpiresAt: Date; readonly deviceId: string; readonly isNew: boolean; readonly newDevice: boolean }
  | { readonly kind: 'WEB'; readonly setCookie: string; readonly csrfToken: string; readonly sessionId: string;
      readonly isNew: boolean; readonly newDevice: boolean; readonly nextStep?: 'SECOND_FACTOR' };

export interface WebRequest {
  readonly method: string;
  readonly cookieHeader?: string | undefined;
  readonly origin?: string | undefined;
  readonly csrfHeader?: string | undefined;
}

export type PinVerification =
  | { readonly outcome: 'OK' }
  | { readonly outcome: 'WRONG' | 'LOCKED' | 'NO_PIN'; readonly endCall: boolean };

type Row = Record<string, unknown>;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function subjectKeyStore(client: pg.ClientBase): SubjectKeyStore {
  return {
    async find(ctx: EncryptionContext): Promise<StoredSubjectKey | undefined> {
      const r = await client.query(SQL.subjectKey, [ctx.subjectId, ctx.dataClass]);
      const row = r.rows[0] as Row | undefined;
      if (!row) return undefined;
      if (row['destroyed_at'] !== null || row['wrapped_dek'] === null) return { destroyed: true };
      return { wrapped: row['wrapped_dek'] as Buffer, keyId: row['kms_key_arn'] as string };
    },
    async insertIfAbsent(ctx, wrapped, keyId) {
      await client.query(SQL.insertSubjectKey, [ctx.subjectId, ctx.dataClass, wrapped, keyId]);
    },
  };
}

export class IdentityService {
  readonly #d: IdentityDeps;

  constructor(deps: IdentityDeps) {
    if (deps.fixedOtpCodes && deps.fixedOtpCodes.size > 0) {
      // 05 §4 / 02 §4: fixed codes only for the reserved fake range, which only non-production deployments accept.
      if (deps.phonePolicy !== 'RESERVED_TEST_RANGE_ONLY') throw new Error('fixed OTP codes require the reserved test phone policy');
      for (const [phone, code] of deps.fixedOtpCodes) {
        if (!phoneAllowed(phone, 'RESERVED_TEST_RANGE_ONLY') || !/^\d{6}$/.test(code)) throw new Error('fixed OTP codes: reserved test numbers and 6-digit codes only');
      }
    }
    if (!surfaceUsesBearerTokens('TECHNICIAN_APP') || surfaceUsesBearerTokens('AGENT_WEB')) throw new Error('X-14 invariant');
    this.#d = deps;
  }

  /** Field crypto bound to a transaction (subject keys are created in the same transaction as the row). */
  #crypto(client: pg.ClientBase): FieldCrypto {
    return createFieldCrypto({ kms: this.#d.kms, store: subjectKeyStore(client), clock: this.#d.clock, cache: this.#d.dekCache });
  }

  #hashRef(value: string): string {
    return hmacSha256(this.#d.keys.requestHashKey, value).subarray(0, 16).toString('hex');
  }

  #now(): Date {
    return this.#d.clock.now();
  }

  async #audit(client: pg.ClientBase, entry: AuditEntry, meta?: RequestMeta): Promise<void> {
    await appendAudit(client, {
      ...entry,
      requestId: meta?.requestId ?? null,
      ipHash: meta ? hmacSha256(this.#d.keys.requestHashKey, `ip|${meta.clientIp}`) : null,
    });
  }

  async #limit(checks: Parameters<RateLimiter['consume']>[0]): Promise<void> {
    const r = await this.#d.rateLimiter.consume(checks, this.#now());
    if (!r.allowed) throw new AppError('RATE_LIMITED', { retryAfterSec: r.retryAfterSec });
  }

  // ---------------------------------------------------------------- OTP

  /** 04 §3 POST /v1/auth/otp/request (LOGIN). The response is identical for registered and unregistered numbers. */
  async requestLoginOtp(input: { phone: string; locale: string; channel: 'SMS' | 'WHATSAPP' | 'VOICE'; integrityToken?: string | undefined }, meta: RequestMeta) {
    if (!phoneAllowed(input.phone, this.#d.phonePolicy)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'phone', code: 'INVALID' }] });
    const now = this.#now();
    const global = await this.#d.rateLimiter.consume([{ rule: RATE_RULES.otpSendGlobal, key: 'all' }], now);
    if (!global.allowed) {
      // ST-09 global breaker: above the forecast every send needs a passing bot check.
      const passed = input.integrityToken !== undefined && (await this.#d.botVerifier.verify(input.integrityToken));
      if (!passed) {
        this.#d.logger.log('warn', 'auth.otp_breaker_open', { outcome: 'BOT_CHECK_REQUIRED' });
        throw new AppError('BOT_CHECK_REQUIRED');
      }
    }
    await this.#limit([
      { rule: RATE_RULES.otpSendPerIp, key: this.#hashRef(`ip|${meta.clientIp}`) },
      { rule: RATE_RULES.otpSendPerDevice, key: meta.deviceRef === undefined ? undefined : this.#hashRef(`dev|${meta.deviceRef}`) },
    ]);
    const bidx = blindIndex(this.#d.keys.blindIndexPepper, input.phone);

    const issued = await withTransaction(this.#d.pool, async (c) => {
      await this.#perPhoneLimits(c, bidx, now);
      let user = (await c.query(SQL.userByBidx, [bidx])).rows[0] as Row | undefined;
      if (!user) {
        const id = newId();
        await c.query(SQL.insertUser, [id, null, bidx, maskPhone(input.phone), input.locale]);
        user = (await c.query(SQL.userByBidx, [bidx])).rows[0] as Row | undefined;
        if (user?.['id'] === id) {
          const phoneEnc = await this.#crypto(c).seal({ subjectId: id, dataClass: 'pii-contact' }, input.phone);
          await c.query(SQL.setPhoneEnc, [id, phoneEnc]);
        }
      }
      if (!user) throw new Error('user upsert failed');
      const userId = user['id'] as string;
      const challengeId = newId();
      const code = this.#d.fixedOtpCodes?.get(input.phone) ?? numericCode(OTP.digits);
      await c.query(SQL.insertOtp, [challengeId, bidx, 'LOGIN', input.channel, otpCodeHmac(this.#d.keys.otpPepper, challengeId, code),
        OTP.maxAttempts, new Date(now.getTime() + OTP.ttlMs), hmacSha256(this.#d.keys.requestHashKey, `ip|${meta.clientIp}`),
        meta.deviceRef === undefined ? null : hmacSha256(this.#d.keys.requestHashKey, `dev|${meta.deviceRef}`), now]);
      const deliver = user['status'] === 'ACTIVE';
      await this.#audit(c, { actorType: 'SYSTEM', action: 'auth.otp_requested', resourceType: 'identity.user', resourceId: userId,
        outcome: 'SUCCESS', changeSummary: { purpose: 'LOGIN', channel: input.channel, delivered: deliver } }, meta);
      return { challengeId, code, userId, deliver };
    });

    if (issued.deliver) await this.#send(issued.challengeId, input.channel, issued.code, issued.userId);
    return { challengeId: issued.challengeId, channel: input.channel, resendAfterSec: OTP.resendCooldownMs / 1000, expiresInSec: OTP.ttlMs / 1000 };
  }

  async #perPhoneLimits(c: pg.ClientBase, bidx: Buffer, now: Date): Promise<void> {
    await c.query(SQL.advisoryLockPhone, [bidx]);
    const counts = (await c.query(SQL.recentOtpCounts, [bidx, now])).rows[0] as { last_30s: number; last_hour: number; last_day: number };
    if (counts.last_30s >= 1) throw new AppError('RATE_LIMITED', { retryAfterSec: OTP.resendCooldownMs / 1000 });
    if (counts.last_hour >= OTP.perPhonePerHour) throw new AppError('RATE_LIMITED', { retryAfterSec: 3600 });
    if (counts.last_day >= OTP.perPhonePerDay) throw new AppError('RATE_LIMITED', { retryAfterSec: 86_400 });
  }

  async #send(challengeId: string, channel: 'SMS' | 'WHATSAPP' | 'VOICE', code: string, userId: string): Promise<void> {
    const accepted = await this.#d.otpSender.sendOtp({ challengeId, channel, code, userId }).then((r) => r.accepted, () => false);
    this.#d.logger.log(accepted ? 'info' : 'warn', 'auth.otp_dispatch', { channel, outcome: accepted ? 'ACCEPTED' : 'FAILED' });
    if (!accepted) throw new AppError('PROVIDER_UNAVAILABLE');
  }

  /** Checks a challenge inside a transaction. Wrong / expired / used challenges all return the same failure. */
  async #checkChallenge(c: pg.ClientBase, challengeId: string, code: string, purpose: 'LOGIN' | 'STEP_UP', now: Date): Promise<Buffer | undefined> {
    const ch = (await c.query(SQL.lockOtp, [challengeId])).rows[0] as Row | undefined;
    if (!ch || ch['purpose'] !== purpose || ch['consumed_at'] !== null || (ch['expires_at'] as Date) <= now
      || (ch['attempts'] as number) >= (ch['max_attempts'] as number)) return undefined;
    const attempts = (ch['attempts'] as number) + 1;
    const ok = constantTimeEqual(otpCodeHmac(this.#d.keys.otpPepper, challengeId, code), ch['code_hmac'] as Buffer);
    // Success consumes the challenge; the last failed attempt invalidates it (ST-08).
    await c.query(SQL.bumpOtpAttempt, [challengeId, ok || attempts >= (ch['max_attempts'] as number), now]);
    return ok ? (ch['phone_bidx'] as Buffer) : undefined;
  }

  /** 04 §3 POST /v1/auth/otp/verify: creates a session for the surface. */
  async verifyLoginOtp(input: {
    challengeId: string; code: string; surface: Surface;
    device: { platform: 'ANDROID_APP' | 'WEB'; appVersion?: string | undefined; deviceId?: string | undefined };
  }, meta: RequestMeta): Promise<LoginResult> {
    const now = this.#now();
    await this.#limit([{ rule: RATE_RULES.otpVerifyPerIp, key: this.#hashRef(`ip|${meta.clientIp}`) }]);
    const expectedPlatform = input.surface === 'TECHNICIAN_APP' ? 'ANDROID_APP' : 'WEB';
    if (input.device.platform !== expectedPlatform) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'device.platform', code: 'INVALID' }] });

    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const bidx = await this.#checkChallenge(c, input.challengeId, input.code, 'LOGIN', now);
      const user = bidx ? ((await c.query(SQL.userByBidx, [bidx])).rows[0] as Row | undefined) : undefined;
      const fail = async (reason: string, error: AppError) => {
        await this.#audit(c, { actorType: 'SYSTEM', action: 'auth.login_failed', resourceType: 'identity.user',
          resourceId: (user?.['id'] as string | undefined) ?? null, outcome: 'FAILED', reasonCode: reason,
          changeSummary: { surface: input.surface } }, meta);
        return { error };
      };
      if (!bidx || !user) return fail('OTP_INVALID', new AppError('OTP_INVALID'));
      const userId = user['id'] as string;
      if (user['status'] !== 'ACTIVE') return fail('ACCOUNT_NOT_ACTIVE', new AppError('ACCOUNT_SUSPENDED'));
      if (!(await this.#d.eligibility.isEligible(userId, input.surface))) return fail('SURFACE_NOT_ALLOWED', new AppError('FORBIDDEN'));

      const isNew = ((await c.query(SQL.priorSessionCount, [userId])).rows[0] as { n: number }).n === 0;
      let deviceId = input.device.deviceId;
      let newDevice = false;
      if (deviceId !== undefined) {
        const d = (await c.query(SQL.deviceForUser, [deviceId, userId])).rows[0] as Row | undefined;
        if (!d || d['revoked_at'] !== null) deviceId = undefined;
        else await c.query(SQL.touchDevice, [deviceId, now, input.device.appVersion ?? null]);
      }
      if (deviceId === undefined) {
        deviceId = newId();
        newDevice = true;
        await c.query(SQL.insertDevice, [deviceId, userId, input.device.platform, input.device.appVersion ?? null, 'UNKNOWN', now]);
      }

      const policy = SESSION_POLICY[input.surface];
      const sessionId = newId();
      const absolute = new Date(now.getTime() + policy.absoluteMs);
      const idle = new Date(now.getTime() + policy.idleMs);
      const web = !surfaceUsesBearerTokens(input.surface);
      const secret = web ? opaqueToken(32) : undefined;
      await c.query(SQL.insertSession, [sessionId, userId, deviceId, input.surface, ['otp'], idle, absolute,
        secret === undefined ? null : tokenHash(secret), now]);

      let result: LoginResult;
      if (secret !== undefined) {
        result = {
          kind: 'WEB', setCookie: sessionCookieHeader(`${sessionId}.${secret}`, policy.absoluteMs / 1000),
          csrfToken: csrfToken(this.#d.keys.csrfKey, sessionId), sessionId, isNew, newDevice,
          ...(input.surface === 'AGENT_WEB' ? { nextStep: 'SECOND_FACTOR' as const } : {}),
        };
      } else {
        const refreshToken = opaqueToken(32);
        await c.query(SQL.insertRefresh, [newId(), sessionId, newId(), tokenHash(refreshToken), now, new Date(Math.min(idle.getTime(), absolute.getTime()))]);
        result = { kind: 'APP', accessToken: await this.#accessToken(userId, sessionId, deviceId, now), refreshToken, sessionId,
          absoluteExpiresAt: absolute, deviceId, isNew, newDevice };
      }
      await this.#audit(c, { actorType: actorKindFor(input.surface), actorId: userId, actorSessionId: sessionId,
        action: 'auth.login_succeeded', resourceType: 'identity.session', resourceId: sessionId, outcome: 'SUCCESS',
        changeSummary: { surface: input.surface, newDevice } }, meta);
      return { result };
    });
    if ('error' in outcome) throw outcome.error;
    this.#d.logger.log('info', 'auth.login', { surface: input.surface, outcome: 'SUCCESS', newDevice: outcome.result.newDevice });
    return outcome.result;
  }

  async #accessToken(userId: string, sessionId: string, deviceId: string, now: Date): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return signJwt(this.#d.tokenSigner, {
      iss: this.#d.issuer, aud: ACCESS_TOKEN_AUDIENCE, sub: userId, sid: sessionId, dev: deviceId, iat, exp: iat + ACCESS_TOKEN_TTL_SEC,
      amr: ['otp'], scp: 'technician',
    });
  }

  // ---------------------------------------------------------------- tokens and sessions

  /** Technician app bearer token → actor (05 §3.1). Session state is re-checked on every request. */
  async authenticateAccessToken(token: string): Promise<Actor> {
    const now = this.#now();
    let claims;
    try {
      claims = verifyJwt(token, { keys: this.#d.tokenVerificationKeys, issuer: this.#d.issuer, audience: ACCESS_TOKEN_AUDIENCE,
        now, maxLifetimeSec: ACCESS_TOKEN_TTL_SEC });
    } catch (error) {
      if (error instanceof JwtError) {
        this.#d.logger.log('info', 'auth.token_rejected', { reason: error.code });
        throw new AppError('UNAUTHENTICATED');
      }
      throw error;
    }
    const sid = claims['sid'];
    if (typeof sid !== 'string' || !/^[0-9a-f-]{36}$/.test(sid)) throw new AppError('UNAUTHENTICATED');
    const s = (await this.#d.pool.query(SQL.sessionForAuth, [sid])).rows[0] as Row | undefined;
    if (!s || s['surface'] !== 'TECHNICIAN_APP' || s['user_id'] !== claims.sub || s['device_id'] !== claims['dev']
      || !this.#sessionLive(s, now)) throw new AppError('UNAUTHENTICATED');
    return this.#actorFromSession(s);
  }

  #sessionLive(s: Row, now: Date): boolean {
    return s['revoked_at'] === null && (s['idle_expires_at'] as Date) > now && (s['absolute_expires_at'] as Date) > now
      && s['user_status'] === 'ACTIVE' && (s['device_revoked_at'] ?? null) === null;
  }

  #actorFromSession(s: Row): Actor {
    const surface = s['surface'] as Surface;
    return {
      kind: actorKindFor(surface), id: s['user_id'] as string, sessionId: s['id'] as string, surface,
      ...(s['step_up_at'] ? { stepUpAt: s['step_up_at'] as Date } : {}),
    };
  }

  /**
   * G-6 / SR-02: the BFF forwards the `__Host-sid` cookie and `api` validates it. Mutating requests additionally need
   * an allowed Origin and the CSRF synchronizer token (ST-12). Agent sessions need their second factor.
   */
  async authenticateWebRequest(req: WebRequest): Promise<Actor> {
    const now = this.#now();
    const raw = (req.cookieHeader ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
    const m = raw ? COOKIE_VALUE.exec(raw.slice(SESSION_COOKIE.length + 1)) : null;
    if (!m) throw new AppError('UNAUTHENTICATED');
    const [sessionId = '', secret = ''] = m.slice(1);
    const s = (await this.#d.pool.query(SQL.sessionForAuth, [sessionId])).rows[0] as Row | undefined;
    if (!s || s['web_secret_hash'] === null || !constantTimeEqual(tokenHash(secret), s['web_secret_hash'] as Buffer) || !this.#sessionLive(s, now)) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (!SAFE_METHODS.has(req.method.toUpperCase())) {
      if (!req.origin || !this.#d.allowedWebOrigins.includes(req.origin) || !verifyCsrfToken(this.#d.keys.csrfKey, sessionId, req.csrfHeader)) {
        this.#d.logger.log('warn', 'auth.csrf_rejected', { surface: s['surface'] as string });
        throw new AppError('CSRF_REJECTED');
      }
    }
    if (s['surface'] === 'AGENT_WEB' && !(s['auth_methods'] as string[]).includes('webauthn')) throw new AppError('SECOND_FACTOR_REQUIRED');
    const policy = SESSION_POLICY[s['surface'] as Surface];
    await this.#d.pool.query(SQL.touchSession, [sessionId, now, new Date(now.getTime() + policy.idleMs)]);
    return this.#actorFromSession(s);
  }

  /** 05 §3.2: rotation with reuse detection. A reused token revokes the whole family and the session. */
  async refresh(input: { refreshToken: string; deviceId: string }, meta: RequestMeta): Promise<{ accessToken: string; refreshToken: string }> {
    const now = this.#now();
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const r = (await c.query(SQL.lockRefresh, [tokenHash(input.refreshToken)])).rows[0] as Row | undefined;
      if (!r) return { error: new AppError('UNAUTHENTICATED') };
      const limited = await this.#d.rateLimiter.consume([{ rule: RATE_RULES.refreshPerSession, key: r['session_id'] as string }], now);
      if (!limited.allowed) return { error: new AppError('RATE_LIMITED', { retryAfterSec: limited.retryAfterSec }) };
      const sessionId = r['session_id'] as string;
      const userId = r['user_id'] as string;
      const revokeAll = async (reason: string) => {
        await c.query(SQL.revokeFamily, [r['family_id'], now]);
        await c.query(SQL.revokeSession, [sessionId, now, reason]);
        await c.query(SQL.revokeSessionTokens, [[sessionId], now]);
        await this.#audit(c, { actorType: 'TECHNICIAN', actorId: userId, actorSessionId: sessionId, action: 'auth.refresh_reuse_detected',
          resourceType: 'identity.session', resourceId: sessionId, outcome: 'DENIED', reasonCode: reason }, meta);
        this.#d.logger.log('warn', 'security.refresh_reuse', { reason: reason });
        return { error: new AppError('SESSION_REVOKED') };
      };
      if (r['revoked_at'] !== null || r['session_revoked_at'] !== null || (r['expires_at'] as Date) <= now || (r['absolute_expires_at'] as Date) <= now) {
        return { error: new AppError('UNAUTHENTICATED') };
      }
      if (r['device_id'] !== input.deviceId) return revokeAll('DEVICE_MISMATCH');
      const successor = hmacSha256(this.#d.keys.refreshRotationKey, `rt|${input.refreshToken}`).toString('base64url');
      if (r['used_at'] !== null) {
        const sinceUse = now.getTime() - (r['used_at'] as Date).getTime();
        if (sinceUse > REFRESH_RETRY_GRACE_MS || r['replaced_by_id'] === null) return revokeAll('REFRESH_REUSE');
        // Network retry from the same device within 10 s: return the same successor (idempotent), no new rotation.
      } else {
        const s = (await c.query(SQL.sessionForAuth, [sessionId])).rows[0] as Row | undefined;
        if (!s || !this.#sessionLive(s, now)) return { error: new AppError('UNAUTHENTICATED') };
        const successorId = newId();
        const absolute = r['absolute_expires_at'] as Date;
        const idle = new Date(Math.min(now.getTime() + SESSION_POLICY.TECHNICIAN_APP.idleMs, absolute.getTime()));
        await c.query(SQL.insertRefresh, [successorId, sessionId, r['family_id'], tokenHash(successor), now, idle]);
        await c.query(SQL.markRefreshUsed, [r['id'], now, successorId]);
        await c.query(SQL.touchSession, [sessionId, now, idle]);
      }
      return { tokens: { accessToken: await this.#accessToken(userId, sessionId, input.deviceId, now), refreshToken: successor } };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  }

  async logout(actor: Actor, meta: RequestMeta): Promise<void> {
    this.#requirePolicy(actor, 'identity.logout', {});
    await withTransaction(this.#d.pool, async (c) => {
      await this.#revokeSessions(c, [actor.sessionId as string], 'LOGOUT');
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null,
        action: 'auth.logout', resourceType: 'identity.session', resourceId: actor.sessionId ?? null, outcome: 'SUCCESS' }, meta);
    });
  }

  async listSessions(actor: Actor): Promise<{ id: string; surface: Surface; createdAt: string; lastSeenAt: string; current: boolean }[]> {
    this.#requirePolicy(actor, 'identity.session.list', {});
    const rows = (await this.#d.pool.query(SQL.listSessions, [actor.id, this.#now()])).rows as Row[];
    return rows.map((r) => ({ id: r['id'] as string, surface: r['surface'] as Surface, createdAt: (r['created_at'] as Date).toISOString(),
      lastSeenAt: (r['last_seen_at'] as Date).toISOString(), current: r['id'] === actor.sessionId }));
  }

  /** Own sessions (CUS / TEC-APP / AGT), or a user's sessions for admins with `security.sessions.revoke` + reason. */
  async revokeSession(actor: Actor, sessionId: string, meta: RequestMeta, reasonCode?: string): Promise<void> {
    await withTransaction(this.#d.pool, async (c) => {
      const owner = (await c.query(SQL.sessionOwner, [sessionId])).rows[0] as Row | undefined;
      const decision = this.#d.policies.can(actor, 'identity.session.revoke',
        { ownerUserId: (owner?.['user_id'] as string | undefined) ?? null, reasonCode: reasonCode ?? null }, { now: this.#now() });
      if (!owner || !decision.allow) {
        throw new AppError(!owner || (!decision.allow && decision.status === 404) ? 'NOT_FOUND' : 'FORBIDDEN');
      }
      await this.#revokeSessions(c, [sessionId], reasonCode ?? 'USER_REQUEST');
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null,
        action: 'auth.session_revoked', resourceType: 'identity.session', resourceId: sessionId, outcome: 'SUCCESS',
        reasonCode: reasonCode ?? 'USER_REQUEST' }, meta);
    });
  }

  async #revokeSessions(c: pg.ClientBase, sessionIds: string[], reason: string): Promise<void> {
    const now = this.#now();
    for (const id of sessionIds) await c.query(SQL.revokeSession, [id, now, reason]);
    await c.query(SQL.revokeSessionTokens, [sessionIds, now]);
  }

  /** 05 §3.3 / §8: suspension revokes every session immediately. */
  async suspendUser(userId: string, reasonCode: string, actor: Actor, meta: RequestMeta): Promise<void> {
    await withTransaction(this.#d.pool, async (c) => {
      await c.query(SQL.suspendUser, [userId, reasonCode]);
      const revoked = (await c.query(SQL.revokeUserSessions, [userId, this.#now(), 'USER_SUSPENDED'])).rows.map((r) => r['id'] as string);
      if (revoked.length > 0) await c.query(SQL.revokeSessionTokens, [revoked, this.#now()]);
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, action: 'identity.user_suspended',
        resourceType: 'identity.user', resourceId: userId, outcome: 'SUCCESS', reasonCode, changeSummary: { revokedSessions: revoked.length } }, meta);
    });
  }

  // ---------------------------------------------------------------- step-up

  async requestStepUpOtp(actor: Actor, meta: RequestMeta): Promise<{ challengeId: string; expiresInSec: number }> {
    this.#requirePolicy(actor, 'identity.step_up', {});
    const now = this.#now();
    const issued = await withTransaction(this.#d.pool, async (c) => {
      const user = (await c.query(SQL.userById, [actor.id])).rows[0] as Row | undefined;
      if (!user || user['status'] !== 'ACTIVE') throw new AppError('UNAUTHENTICATED');
      const bidx = user['phone_bidx'] as Buffer;
      await this.#perPhoneLimits(c, bidx, now);
      const challengeId = newId();
      const code = numericCode(OTP.digits);
      await c.query(SQL.insertOtp, [challengeId, bidx, 'STEP_UP', 'SMS', otpCodeHmac(this.#d.keys.otpPepper, challengeId, code), OTP.maxAttempts,
        new Date(now.getTime() + OTP.ttlMs), hmacSha256(this.#d.keys.requestHashKey, `ip|${meta.clientIp}`), null, now]);
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null,
        action: 'auth.otp_requested', resourceType: 'identity.user', resourceId: actor.id ?? null, outcome: 'SUCCESS',
        changeSummary: { purpose: 'STEP_UP', channel: 'SMS' } }, meta);
      return { challengeId, code };
    });
    await this.#send(issued.challengeId, 'SMS', issued.code, actor.id ?? '');
    return { challengeId: issued.challengeId, expiresInSec: OTP.ttlMs / 1000 };
  }

  async completeStepUp(actor: Actor, input: { challengeId: string; code: string }, meta: RequestMeta): Promise<void> {
    this.#requirePolicy(actor, 'identity.step_up', {});
    const now = this.#now();
    const outcome = await withTransaction(this.#d.pool, async (c) => {
      const bidx = await this.#checkChallenge(c, input.challengeId, input.code, 'STEP_UP', now);
      const user = (await c.query(SQL.userById, [actor.id])).rows[0] as Row | undefined;
      const ok = bidx !== undefined && user !== undefined && Buffer.isBuffer(user['phone_bidx']) && constantTimeEqual(bidx, user['phone_bidx']);
      if (ok) await c.query(SQL.setStepUp, [actor.sessionId, now]);
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, actorSessionId: actor.sessionId ?? null,
        action: 'auth.step_up', resourceType: 'identity.session', resourceId: actor.sessionId ?? null, outcome: ok ? 'SUCCESS' : 'FAILED' }, meta);
      return ok;
    });
    if (!outcome) throw new AppError('OTP_INVALID');
  }

  // ---------------------------------------------------------------- IVR PIN (05 §2.3)

  async setIvrPin(input: { userId: string; pin: string; via: 'IVR_SELF' | 'AGENT_ASSISTED_VERIFIED' | 'APP' }, actor: Actor, meta: RequestMeta): Promise<void> {
    const reason = pinRejectionReason(input.pin);
    if (reason) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'pin', code: reason }] });
    const hash = await hashSecret(input.pin);
    await withTransaction(this.#d.pool, async (c) => {
      await c.query(SQL.upsertPin, [input.userId, hash, this.#now(), input.via]);
      await this.#audit(c, { actorType: this.#auditActor(actor), actorId: actor.id ?? null, action: 'auth.ivr_pin_set',
        resourceType: 'identity.user', resourceId: input.userId, outcome: 'SUCCESS', changeSummary: { via: input.via } }, meta);
    });
  }

  /** 3 wrong per call ends the call; 5 wrong within 24 h locks the PIN until an ops-verified reset. */
  async verifyIvrPin(input: { userId: string; pin: string; failuresThisCall: number }, meta: RequestMeta): Promise<PinVerification> {
    const now = this.#now();
    const row = (await this.#d.pool.query(SQL.pinHash, [input.userId])).rows[0] as Row | undefined;
    // Argon2 runs outside the transaction (no lock held during the slow hash); the counter update is transactional.
    const matches = row ? await verifySecret(row['pin_hash'] as string, input.pin) : false;
    return withTransaction(this.#d.pool, async (c) => {
      const cred = (await c.query(SQL.pinCredential, [input.userId, now])).rows[0] as Row | undefined;
      const audit = (outcome: 'SUCCESS' | 'DENIED' | 'FAILED', reasonCode: string | null) => this.#audit(c, { actorType: 'TECHNICIAN',
        actorId: input.userId, action: 'auth.ivr_pin_verified', resourceType: 'identity.user', resourceId: input.userId, outcome, reasonCode }, meta);
      if (!cred) return { outcome: 'NO_PIN', endCall: true } as const;
      if (cred['locked'] === true) {
        await audit('DENIED', 'PIN_LOCKED');
        return { outcome: 'LOCKED', endCall: true } as const;
      }
      if (matches && cred['pin_hash'] === row?.['pin_hash']) {
        const rehash = needsRehash(cred['pin_hash'] as string) ? await hashSecret(input.pin) : null;
        await c.query(SQL.pinSuccess, [input.userId, rehash]);
        return { outcome: 'OK' } as const;
      }
      const windowStart = cred['failure_window_started_at'] as Date | null;
      const inWindow = windowStart !== null && now.getTime() - windowStart.getTime() < IVR_PIN.failureWindowMs;
      const failures = (inWindow ? (cred['failed_attempts'] as number) : 0) + 1;
      const lock = failures >= IVR_PIN.maxFailuresPer24h;
      await c.query(SQL.pinFailure, [input.userId, failures, inWindow ? windowStart : now, lock]);
      await audit('FAILED', lock ? 'PIN_LOCKED_NOW' : 'PIN_WRONG');
      if (lock) this.#d.logger.log('warn', 'security.ivr_pin_locked', { outcome: 'LOCKED' });
      return { outcome: lock ? 'LOCKED' : 'WRONG', endCall: lock || input.failuresThisCall + 1 >= IVR_PIN.maxFailuresPerCall } as const;
    });
  }

  // ---------------------------------------------------------------- erasure (identity part of the DSR saga)

  /** SR-07: null the PII, destroy the subject keys (crypto-shredding), revoke sessions and devices. Worker role. */
  async eraseIdentity(userId: string, meta: RequestMeta): Promise<void> {
    const now = this.#now();
    await withTransaction(this.#d.pool, async (c) => {
      const revoked = (await c.query(SQL.revokeUserSessions, [userId, now, 'ERASED'])).rows.map((r) => r['id'] as string);
      if (revoked.length > 0) await c.query(SQL.revokeSessionTokens, [revoked, now]);
      await c.query(SQL.eraseUser, [userId, now]);
      await c.query(SQL.destroySubjectKeys, [userId, now]);
      await c.query(SQL.revokeUserDevices, [userId, now]);
      await c.query(SQL.deleteIvrCredential, [userId]);
      await this.#audit(c, { actorType: 'SYSTEM', action: 'identity.erased', resourceType: 'identity.user', resourceId: userId,
        outcome: 'SUCCESS', changeSummary: { revokedSessions: revoked.length } }, meta);
    });
    for (const key of this.#d.dekCache.keys()) if (key.startsWith(`${userId}|`)) this.#d.dekCache.delete(key);
  }

  /** Reveal path (SR-06): decrypts the user's phone for delivery by comms. Fails for erased users and for roles without
   *  the pii-contact grant. */
  async revealPhoneForDelivery(userId: string): Promise<string> {
    const client = await this.#d.pool.connect();
    try {
      const r = (await client.query(SQL.phoneEnc, [userId])).rows[0] as Row | undefined;
      if (!r || r['phone_enc'] === null) throw new AppError('NOT_FOUND');
      return await this.#crypto(client).open({ subjectId: userId, dataClass: 'pii-contact' }, r['phone_enc'] as Buffer);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- helpers

  #requirePolicy(actor: Actor, action: string, resource: unknown): void {
    const d = this.#d.policies.can(actor, action, resource, { now: this.#now() });
    if (!d.allow) throw new AppError(d.status === 404 ? 'NOT_FOUND' : actor.kind === 'ANONYMOUS' ? 'UNAUTHENTICATED' : 'FORBIDDEN');
  }

  #auditActor(actor: Actor): AuditEntry['actorType'] {
    return actor.kind === 'ANONYMOUS' ? 'SYSTEM' : actor.kind;
  }
}
