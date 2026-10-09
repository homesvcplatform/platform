// Composition of the `api` process role (Gate 3): wiring only (B6). Builds the policy registry (default deny), checks
// that every declared endpoint has a registered policy and an idempotency declaration (B11 / B12), and wires the
// identity module to its ports. The HTTP framework adapter (ADR-014 NestJS) is attached in a later gate; until then
// `http` is the framework-neutral handler used by the tests.
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { createIdentityHttp, identityEndpoints } from '@hsp/module-identity/http';
import {
  IdentityService, registerIdentityPolicies, type BotVerifier, type IdentityKeys, type OtpSender, type PhonePolicy, type SurfaceEligibility,
} from '@hsp/module-identity';
import type { Logger } from '@hsp/observability';
import { assertEndpointRegistry, PolicyRegistry } from '@hsp/policy';
import { assertRateLimitStore, createDekCache, createRateLimiter, type JwtSigner, type KeyManagementPort, type RateLimitStore } from '@hsp/security';

export interface ApiComposition {
  readonly identity: IdentityService;
  readonly http: ReturnType<typeof createIdentityHttp>;
  readonly policies: PolicyRegistry;
}

export interface ApiCompositionOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly kms: KeyManagementPort;
  readonly tokenSigner: JwtSigner;
  readonly tokenVerificationKeys: ReadonlyMap<string, KeyObject>;
  readonly issuer: string;
  readonly keys: IdentityKeys;
  readonly otpSender: OtpSender;
  readonly eligibility: SurfaceEligibility;
  readonly botVerifier: BotVerifier;
  readonly phonePolicy: PhonePolicy;
  readonly allowedWebOrigins: readonly string[];
  readonly fixedOtpCodes?: ReadonlyMap<string, string>;
  readonly appEnv: AppEnvironment;
  /** Required. Deployed environments need the shared atomic (Valkey) store; `MemoryRateLimitStore` is local / test only. */
  readonly rateLimitStore: RateLimitStore | undefined;
}

export function composeApi(o: ApiCompositionOptions): ApiComposition {
  const rateLimitStore = assertRateLimitStore(o.rateLimitStore, o.appEnv);
  const policies = new PolicyRegistry((d) => {
    if (!d.allow) o.logger.log('info', 'authz.denied', { policyAction: d.action, actorKind: d.actorKind, reason: d.reason ?? 'UNKNOWN' });
  });
  registerIdentityPolicies(policies);
  assertEndpointRegistry(identityEndpoints, policies);
  const identity = new IdentityService({
    pool: o.pool, clock: o.clock, kms: o.kms, dekCache: createDekCache(), keys: o.keys, tokenSigner: o.tokenSigner,
    tokenVerificationKeys: o.tokenVerificationKeys, issuer: o.issuer, rateLimiter: createRateLimiter(rateLimitStore),
    logger: o.logger, otpSender: o.otpSender, eligibility: o.eligibility, botVerifier: o.botVerifier, policies, phonePolicy: o.phonePolicy,
    allowedWebOrigins: o.allowedWebOrigins, ...(o.fixedOtpCodes ? { fixedOtpCodes: o.fixedOtpCodes } : {}),
  });
  return { identity, http: createIdentityHttp(identity), policies };
}
