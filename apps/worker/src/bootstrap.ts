// Composition of the `worker` process role (Gates 5–6): wiring only (B6). Runs the durable timers of the jobs lifecycle
// and the quote expiry (Graphile Worker, ADR-015 / ADR-026 #3), the 1-minute sweepers that repair any overdue state a
// lost timer missed, and (Gate 6, ADR-027 #14) the outbox relay with the jobs consumer of the quote events (repair
// orders from approvals). The worker role has no data-class KMS grant, so it can't open addresses (it never needs to).
import type pg from 'pg';
import { startTimerRunner } from '@hsp/db';
import { createOutboxRelay, RELAY_TASK } from '@hsp/events';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { CatalogService, registerCatalogPolicies } from '@hsp/module-catalog';
import { recordDisclosure } from '@hsp/module-compliance';
import { CustomersService } from '@hsp/module-customers';
import {
  DIAGNOSIS_TIMER_TASKS, DiagnosisService, FIXTURE_DIAGNOSIS_POLICY, registerDiagnosisPolicies, type DiagnosisPolicy,
} from '@hsp/module-diagnosis';
import { GeoService } from '@hsp/module-geo';
import { subjectKeyStore } from '@hsp/module-identity';
import { FIXTURE_LIFECYCLE_POLICY, JobsService, registerJobsPolicies, TIMER_TASKS, type LifecyclePolicy } from '@hsp/module-jobs';
import { createPlaceholderBillIssuer } from '@hsp/module-payments';
import { PricingService } from '@hsp/module-pricing';
import { TechnicianDirectory } from '@hsp/module-workforce';
import type { Logger } from '@hsp/observability';
import { PolicyRegistry } from '@hsp/policy';
import { assertRateLimitStore, createDekCache, createRateLimiter, type KeyManagementPort, type RateLimitStore } from '@hsp/security';

export interface WorkerCompositionOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The worker role's KMS view (no data-class grants under SR-06). */
  readonly kms: KeyManagementPort;
  readonly appEnv: AppEnvironment;
  readonly rateLimitStore: RateLimitStore | undefined;
  readonly jobsCodeKey: Buffer;
  readonly requestHashKey: Buffer;
  readonly lifecyclePolicy?: LifecyclePolicy;
  readonly diagnosisPolicy?: DiagnosisPolicy;
  /** Relay retry spacing (tests shorten it). */
  readonly relayRetryAfterMs?: number;
}

/** The worker never sends OTPs, delivers links or reads calls: these diagnosis ports refuse if ever reached. */
const notInWorker = async (): Promise<never> => {
  throw new Error('not available in the worker role');
};

export function composeWorker(o: WorkerCompositionOptions) {
  const policies = new PolicyRegistry();
  registerCatalogPolicies(policies);
  registerJobsPolicies(policies);
  registerDiagnosisPolicies(policies);
  const rateLimiter = createRateLimiter(assertRateLimitStore(o.rateLimitStore, o.appEnv));
  const geo = new GeoService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, appEnv: o.appEnv });
  const catalog = new CatalogService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, cities: geo });
  const pricing = new PricingService({ pool: o.pool, clock: o.clock });
  const customers = new CustomersService({ pool: o.pool, clock: o.clock, kms: o.kms, dekCache: createDekCache(), keyStore: subjectKeyStore, localities: geo });
  const technicians = new TechnicianDirectory(o.pool);
  const diagnosis: DiagnosisService = new DiagnosisService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.diagnosisPolicy ?? FIXTURE_DIAGNOSIS_POLICY, requestHashKey: o.requestHashKey,
    appEnv: o.appEnv, jobs: { diagnosisVisitFacts: (v) => jobs.diagnosisVisitFacts(v), quoteJobFacts: (j) => jobs.quoteJobFacts(j) }, catalog, pricing,
    skills: technicians, otp: { requestQuoteApprovalOtp: notInWorker, verifyQuoteApprovalOtp: notInWorker }, links: { deliver: notInWorker },
    callEvidence: { bridgedCall: notInWorker, recordedCustomerCall: notInWorker },
  });
  const jobs = new JobsService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.lifecyclePolicy ?? FIXTURE_LIFECYCLE_POLICY, codeKey: o.jobsCodeKey,
    requestHashKey: o.requestHashKey, addresses: customers, offers: catalog, pricing, technicians, localities: geo,
    bills: createPlaceholderBillIssuer(pricing), recordDisclosure: (e) => recordDisclosure(o.pool, e),
    repairQuotes: diagnosis.repairQuotes(), materialUsage: diagnosis.materialUsageRecorder(), repairSkills: technicians,
  });
  const relay = createOutboxRelay({ pool: o.pool, consumers: [jobs.eventConsumer()], logger: o.logger,
    ...(o.relayRetryAfterMs !== undefined ? { retryAfterMs: o.relayRetryAfterMs } : {}) });
  const tasks = {
    ...jobs.timerTasks(),
    ...diagnosis.timerTasks(),
    [RELAY_TASK]: async () => {
      await relay.drain();
    },
  };
  return {
    jobs,
    diagnosis,
    relay,
    /**
     * Starts the runner with every jobs / diagnosis task and the relay, plus the 1-minute cron fallbacks (jobs and
     * diagnosis sweepers, relay). `stop()` drains, `kill()` simulates a crash.
     */
    startTimers: (opts: { pollIntervalMs?: number; withSweeper?: boolean } = {}) => startTimerRunner({
      pool: o.pool, tasks, ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.withSweeper === false ? {} : {
        crontab: [`* * * * * ${TIMER_TASKS.sweep}`, `* * * * * ${DIAGNOSIS_TIMER_TASKS.sweep}`, `* * * * * ${RELAY_TASK}`].join('\n'),
      }),
    }),
  };
}
