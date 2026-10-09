// Composition of the `admin-api` process role (Gate 3, Gate 4): wiring only (B6). Admin realm: backoffice (IdP
// assertion + admin session, passkeys, grants, change requests) plus the identity facade for admin actions on user
// sessions (05 §3.3, matrix row "Revoke sessions"). Change-request actions come from their owning modules: catalog
// (city service rules) and geo (city languages), ADR-025 #5, and jobs (arrival / completion overrides). Gate 6: diagnosis
// ops-desk capture (local / test only until telephony, ADR-027 #3). One policy registry with default deny; every
// endpoint must declare its policy (B11 / B12).
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { createBackofficeHttp, backofficeEndpoints, PROXY_ASSERTION_HEADER } from '@hsp/module-backoffice/http';
import { BackofficeService, registerBackofficePolicies, type IdpConfig } from '@hsp/module-backoffice';
import { CatalogService, registerCatalogPolicies, serviceRulesChangeAction } from '@hsp/module-catalog';
import { recordDisclosure } from '@hsp/module-compliance';
import { CustomersService } from '@hsp/module-customers';
import { createDiagnosisAdminHttp, diagnosisAdminEndpoints } from '@hsp/module-diagnosis/http';
import { DiagnosisService, FIXTURE_DIAGNOSIS_POLICY, registerDiagnosisPolicies, type CallEvidence, type DiagnosisPolicy } from '@hsp/module-diagnosis';
import { createJobsAdminHttp, jobsAdminEndpoints, type JobsHttpRequest } from '@hsp/module-jobs/http';
import {
  arrivalOverrideChangeAction, completionOverrideChangeAction, FIXTURE_LIFECYCLE_POLICY, JobsService, registerJobsPolicies, type LifecyclePolicy,
} from '@hsp/module-jobs';
import { createPlaceholderBillIssuer } from '@hsp/module-payments';
import { PricingService } from '@hsp/module-pricing';
import { TechnicianDirectory } from '@hsp/module-workforce';
import { cityLocalesChangeAction, GeoService } from '@hsp/module-geo';
import { IdentityService, registerIdentityPolicies, subjectKeyStore, type IdentityKeys } from '@hsp/module-identity';
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
  /** HMAC key for visit codes (same secret as the api role). */
  readonly jobsCodeKey: Buffer;
  readonly lifecyclePolicy?: LifecyclePolicy;
  readonly diagnosisPolicy?: DiagnosisPolicy;
  /** Bridged-call evidence for ops-desk capture (telephony, Gate 10); none by default (fake in tests). */
  readonly callEvidence?: CallEvidence;
}

const noCallEvidence: CallEvidence = { bridgedCall: async () => false, recordedCustomerCall: async () => false };
const noLinkDelivery = { deliver: async () => undefined };

const unavailable = { async sendOtp() { return { accepted: false }; } };

export function composeAdminApi(o: AdminApiCompositionOptions) {
  const policies = new PolicyRegistry((d) => {
    if (!d.allow) o.logger.log('info', 'authz.denied', { policyAction: d.action, actorKind: d.actorKind, reason: d.reason ?? 'UNKNOWN' });
  });
  registerBackofficePolicies(policies);
  registerIdentityPolicies(policies);
  registerCatalogPolicies(policies);
  registerJobsPolicies(policies);
  registerDiagnosisPolicies(policies);
  assertEndpointRegistry([...backofficeEndpoints, ...jobsAdminEndpoints, ...diagnosisAdminEndpoints], policies);
  const rateLimiter = createRateLimiter(assertRateLimitStore(o.rateLimitStore, o.appEnv));
  const geo = new GeoService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, appEnv: o.appEnv });
  const dekCache = createDekCache();
  const catalog = new CatalogService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, cities: geo });
  const pricing = new PricingService({ pool: o.pool, clock: o.clock });
  const customers = new CustomersService({ pool: o.pool, clock: o.clock, kms: o.identity.kms, dekCache, keyStore: subjectKeyStore, localities: geo });
  const technicians = new TechnicianDirectory(o.pool);
  const identity = new IdentityService({
    pool: o.pool, clock: o.clock, kms: o.identity.kms, dekCache, keys: o.identity.keys, tokenSigner: o.identity.tokenSigner,
    tokenVerificationKeys: o.identity.tokenVerificationKeys, issuer: o.identity.issuer, rateLimiter, logger: o.logger,
    otpSender: unavailable, eligibility: { isEligible: async () => false }, botVerifier: { verify: async () => false }, policies,
    phonePolicy: 'RESERVED_TEST_RANGE_ONLY', allowedWebOrigins: [],
  });
  const diagnosis: DiagnosisService = new DiagnosisService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.diagnosisPolicy ?? FIXTURE_DIAGNOSIS_POLICY, requestHashKey: o.requestHashKey,
    appEnv: o.appEnv, jobs: { diagnosisVisitFacts: (v) => jobs.diagnosisVisitFacts(v), quoteJobFacts: (j) => jobs.quoteJobFacts(j) }, catalog, pricing,
    skills: technicians, otp: identity, links: noLinkDelivery, callEvidence: o.callEvidence ?? noCallEvidence,
  });
  const jobs = new JobsService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.lifecyclePolicy ?? FIXTURE_LIFECYCLE_POLICY, codeKey: o.jobsCodeKey,
    requestHashKey: o.requestHashKey, addresses: customers, offers: catalog, pricing, technicians, localities: geo,
    bills: createPlaceholderBillIssuer(pricing), recordDisclosure: (e) => recordDisclosure(o.pool, e),
    repairQuotes: diagnosis.repairQuotes(), materialUsage: diagnosis.materialUsageRecorder(), repairSkills: technicians,
  });
  const changeActions = [
    serviceRulesChangeAction({ pool: o.pool, cities: geo }),
    cityLocalesChangeAction({ pool: o.pool, appEnv: o.appEnv, ...(o.catalogIssues ? { catalogIssues: o.catalogIssues } : {}) }),
    arrivalOverrideChangeAction(jobs),
    completionOverrideChangeAction(jobs),
  ];
  const backoffice = new BackofficeService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, idp: o.idp, webauthn: o.webauthn, csrfKey: o.csrfKey,
    requestHashKey: o.requestHashKey, allowedOrigins: o.allowedOrigins, appEnv: o.appEnv, changeActions,
  });
  const adminActor = (req: JobsHttpRequest) => backoffice.authenticate({ method: req.method, proxyAssertion: req.headers[PROXY_ASSERTION_HEADER],
    cookieHeader: req.headers['cookie'], origin: req.headers['origin'], csrfHeader: req.headers['x-csrf-token'] });
  return { backoffice, identity, jobs, diagnosis, policies, http: createBackofficeHttp(backoffice), jobsHttp: createJobsAdminHttp(jobs, adminActor),
    diagnosisHttp: createDiagnosisAdminHttp(diagnosis, adminActor) };
}
