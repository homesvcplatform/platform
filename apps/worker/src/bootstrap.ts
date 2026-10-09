// Composition of the `worker` process role (Gate 5): wiring only (B6). Runs the durable timers of the jobs lifecycle
// (Graphile Worker, ADR-015 / ADR-026 #3) and the 1-minute sweeper that repairs any overdue state a lost timer missed.
// The worker role has no data-class KMS grant, so it can't open addresses (it never needs to).
import type pg from 'pg';
import { startTimerRunner } from '@hsp/db';
import type { AppEnvironment, Clock } from '@hsp/kernel';
import { CatalogService, registerCatalogPolicies } from '@hsp/module-catalog';
import { recordDisclosure } from '@hsp/module-compliance';
import { CustomersService } from '@hsp/module-customers';
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
}

export function composeWorker(o: WorkerCompositionOptions) {
  const policies = new PolicyRegistry();
  registerCatalogPolicies(policies);
  registerJobsPolicies(policies);
  const rateLimiter = createRateLimiter(assertRateLimitStore(o.rateLimitStore, o.appEnv));
  const geo = new GeoService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, appEnv: o.appEnv });
  const catalog = new CatalogService({ pool: o.pool, clock: o.clock, logger: o.logger, policies, rateLimiter, cities: geo });
  const pricing = new PricingService({ pool: o.pool, clock: o.clock });
  const customers = new CustomersService({ pool: o.pool, clock: o.clock, kms: o.kms, dekCache: createDekCache(), keyStore: subjectKeyStore, localities: geo });
  const jobs = new JobsService({
    pool: o.pool, clock: o.clock, logger: o.logger, policies, policy: o.lifecyclePolicy ?? FIXTURE_LIFECYCLE_POLICY, codeKey: o.jobsCodeKey,
    requestHashKey: o.requestHashKey, addresses: customers, offers: catalog, pricing, technicians: new TechnicianDirectory(o.pool), localities: geo,
    bills: createPlaceholderBillIssuer(pricing), recordDisclosure: (e) => recordDisclosure(o.pool, e),
  });
  return {
    jobs,
    /** Starts the timer runner with every jobs task and the 1-minute sweeper (`stop()` drains, `kill()` simulates a crash). */
    startTimers: (opts: { pollIntervalMs?: number; withSweeper?: boolean } = {}) => startTimerRunner({
      pool: o.pool, tasks: jobs.timerTasks(), ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.withSweeper === false ? {} : { crontab: `* * * * * ${TIMER_TASKS.sweep}` }),
    }),
  };
}
