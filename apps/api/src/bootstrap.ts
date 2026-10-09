// Composition of the `api` process role (Gates 3–5): wiring only (B6). Builds the policy registry (default deny), checks
// that every declared endpoint has a registered policy and an idempotency declaration (B11 / B12), and wires identity,
// the public geo / catalog reads (catalog's city lookup is geo, ADR-025 #8) and the jobs lifecycle with its ports
// (customers addresses, pricing, catalog, workforce, geo, compliance disclosure log, the TCP-3 placeholder bill issuer).
// The HTTP framework adapter (ADR-024 #1: decorator-free) is attached in a later gate; until then the handlers are
// framework-neutral functions used by the tests.
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { catalogEndpoints, createCatalogHttp } from '@hsp/module-catalog/http';
import { CatalogService, registerCatalogPolicies } from '@hsp/module-catalog';
import { createGeoHttp, geoEndpoints } from '@hsp/module-geo/http';
import { GeoService, registerGeoPolicies } from '@hsp/module-geo';
import { recordDisclosure } from '@hsp/module-compliance';
import { CustomersService } from '@hsp/module-customers';
import { createIdentityHttp, identityEndpoints } from '@hsp/module-identity/http';
import {
  IdentityService, registerIdentityPolicies, subjectKeyStore, type BotVerifier, type IdentityKeys, type OtpSender, type PhonePolicy,
  type SurfaceEligibility,
} from '@hsp/module-identity';
import { createJobsHttp, jobsEndpoints, type JobsHttpRequest } from '@hsp/module-jobs/http';
import { FIXTURE_LIFECYCLE_POLICY, JobsService, registerJobsPolicies, type LifecyclePolicy } from '@hsp/module-jobs';
import { createPlaceholderBillIssuer } from '@hsp/module-payments';
import { PricingService } from '@hsp/module-pricing';
import { TechnicianDirectory } from '@hsp/module-workforce';
import type { Logger } from '@hsp/observability';
import { assertEndpointRegistry, PolicyRegistry, type Actor } from '@hsp/policy';
import { assertRateLimitStore, createDekCache, createRateLimiter, type JwtSigner, type KeyManagementPort, type RateLimitStore } from '@hsp/security';

export interface ApiComposition {
  readonly identity: IdentityService;
  readonly http: ReturnType<typeof createIdentityHttp>;
  readonly geo: GeoService;
  readonly geoHttp: ReturnType<typeof createGeoHttp>;
  readonly catalog: CatalogService;
  readonly catalogHttp: ReturnType<typeof createCatalogHttp>;
  readonly jobs: JobsService;
  readonly jobsHttp: ReturnType<typeof createJobsHttp>;
  readonly pricing: PricingService;
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
  /** HMAC key for visit start / completion codes (Secrets Manager when deployed). */
  readonly jobsCodeKey: Buffer;
  /** Lifecycle policy values; defaults to the fixture values (NOT FINAL, ADR-026 #6). */
  readonly lifecyclePolicy?: LifecyclePolicy;
}

export function composeApi(o: ApiCompositionOptions): ApiComposition {
  const rateLimitStore = assertRateLimitStore(o.rateLimitStore, o.appEnv);
  const policies = new PolicyRegistry((d) => {
    if (!d.allow) o.logger.log('info', 'authz.denied', { policyAction: d.action, actorKind: d.actorKind, reason: d.reason ?? 'UNKNOWN' });
  });
  registerIdentityPolicies(policies);
  registerGeoPolicies(policies);
  registerCatalogPolicies(policies);
  registerJobsPolicies(policies);
  assertEndpointRegistry([...identityEndpoints, ...geoEndpoints, ...catalogEndpoints, ...jobsEndpoints], policies);
  const dekCache = createDekCache();
  const rateLimiter = createRateLimiter(rateLimitStore);
  const identity = new IdentityService({
    pool: o.pool, clock: o.clock, kms: o.kms, dekCache, keys: o.keys, tokenSigner: o.tokenSigner,
    tokenVerificationKeys: o.tokenVerificationKeys, issuer: o.issuer, rateLimiter,
    logger: o.logger, otpSender: o.otpSender, eligibility: o.eligibility, botVerifier: o.botVerifier, policies, phonePolicy: o.phonePolicy,
    allowedWebOrigins: o.allowedWebOrigins, ...(o.fixedOtpCodes ? { fixedOtpCodes: o.fixedOtpCodes } : {}),
  });
  const geo = new GeoService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, appEnv: o.appEnv });
  const catalog = new CatalogService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, cities: geo });
  const pricing = new PricingService({ pool: o.pool, clock: o.clock });
  const customers = new CustomersService({ pool: o.pool, clock: o.clock, kms: o.kms, dekCache, keyStore: subjectKeyStore, localities: geo });
  const jobs = new JobsService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.lifecyclePolicy ?? FIXTURE_LIFECYCLE_POLICY, codeKey: o.jobsCodeKey,
    requestHashKey: o.keys.requestHashKey, addresses: customers, offers: catalog, pricing, technicians: new TechnicianDirectory(o.pool), localities: geo,
    bills: createPlaceholderBillIssuer(pricing), recordDisclosure: (e) => recordDisclosure(o.pool, e),
  });
  // Customer (cookie + CSRF) or technician (bearer) session → actor, as the identity handlers do.
  const authenticate = async (req: JobsHttpRequest): Promise<Actor> => {
    const authz = req.headers['authorization'];
    if (authz !== undefined) {
      const m = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authz);
      return identity.authenticateAccessToken(m?.[1] ?? '');
    }
    return identity.authenticateWebRequest({ method: req.method, cookieHeader: req.headers['cookie'], origin: req.headers['origin'], csrfHeader: req.headers['x-csrf-token'] });
  };
  return {
    identity, http: createIdentityHttp(identity), geo, geoHttp: createGeoHttp(geo), catalog, catalogHttp: createCatalogHttp(catalog),
    jobs, jobsHttp: createJobsHttp(jobs, authenticate), pricing, policies,
  };
}
