// Composition of the `admin-api` process role (Gate 3, Gate 4): wiring only (B6). Admin realm: backoffice (IdP
// assertion + admin session, passkeys, grants, change requests) plus the identity facade for admin actions on user
// sessions (05 §3.3, matrix row "Revoke sessions"). Change-request actions come from their owning modules: catalog
// (city service rules) and geo (city languages), ADR-025 #5. One policy registry with default deny; every endpoint must
// declare its policy (B11 / B12).
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { createBackofficeHttp, backofficeEndpoints } from '@hsp/module-backoffice/http';
import { BackofficeService, registerBackofficePolicies, type IdpConfig } from '@hsp/module-backoffice';
import { serviceRulesChangeAction } from '@hsp/module-catalog';
import { cityLocalesChangeAction, GeoService } from '@hsp/module-geo';
import { IdentityService, registerIdentityPolicies, type IdentityKeys } from '@hsp/module-identity';
import type { CatalogIssue } from '@hsp/localization';
import type { Logger } from '@hsp/observability';
import { assertEndpointRegistry, PolicyRegistry } from '@hsp/policy';
import { assertRateLimitStore, createDekCache, createRateLimiter, type JwtSigner, type KeyManagementPort, type RateLimitStore } from '@hsp/security';

export interface AdminApiCompositionOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly idp: IdpConfig;
  readonly webauthn: { readonly rpId: string; readonly origin: string };
  readonly csrfKey: Buffer;
  readonly requestHashKey: Buffer;
  readonly allowedOrigins: readonly string[];
  readonly appEnv: AppEnvironment;
  /** Required. Deployed environments need the shared atomic (Valkey) store; `MemoryRateLimitStore` is local / test only. */
  readonly rateLimitStore: RateLimitStore | undefined;
  /** Identity facade (admin actions on user sessions): same KMS / keys as the api, admin-api role grants. */
  readonly identity: {
    readonly kms: KeyManagementPort;
    readonly keys: IdentityKeys;
    readonly tokenSigner: JwtSigner;
    readonly tokenVerificationKeys: ReadonlyMap<string, KeyObject>;
    readonly issuer: string;
  };
  /** Translation-catalog issues for the locale enablement gate; defaults to the repository catalogs (tests inject). */
  readonly catalogIssues?: () => readonly CatalogIssue[];
}

const unavailable = { async sendOtp() { return { accepted: false }; } };

export function composeAdminApi(o: AdminApiCompositionOptions) {
  const policies = new PolicyRegistry((d) => {
    if (!d.allow) o.logger.log('info', 'authz.denied', { policyAction: d.action, actorKind: d.actorKind, reason: d.reason ?? 'UNKNOWN' });
  });
  registerBackofficePolicies(policies);
  registerIdentityPolicies(policies);
  assertEndpointRegistry(backofficeEndpoints, policies);
  const rateLimiter = createRateLimiter(assertRateLimitStore(o.rateLimitStore, o.appEnv));
  const geo = new GeoService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, appEnv: o.appEnv });
  const changeActions = [
    serviceRulesChangeAction({ pool: o.pool, cities: geo }),
    cityLocalesChangeAction({ pool: o.pool, appEnv: o.appEnv, ...(o.catalogIssues ? { catalogIssues: o.catalogIssues } : {}) }),
  ];
  const backoffice = new BackofficeService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, idp: o.idp, webauthn: o.webauthn, csrfKey: o.csrfKey,
    requestHashKey: o.requestHashKey, allowedOrigins: o.allowedOrigins, appEnv: o.appEnv, changeActions,
  });
  const identity = new IdentityService({
    pool: o.pool, clock: o.clock, kms: o.identity.kms, dekCache: createDekCache(), keys: o.identity.keys, tokenSigner: o.identity.tokenSigner,
    tokenVerificationKeys: o.identity.tokenVerificationKeys, issuer: o.identity.issuer, rateLimiter, logger: o.logger,
    otpSender: unavailable, eligibility: { isEligible: async () => false }, botVerifier: { verify: async () => false }, policies,
    phonePolicy: 'RESERVED_TEST_RANGE_ONLY', allowedWebOrigins: [],
  });
  return { backoffice, identity, policies, http: createBackofficeHttp(backoffice) };
}
