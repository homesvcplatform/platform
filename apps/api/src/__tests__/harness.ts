// Test composition of the api role against a throwaway database (TE-02): real migrations, a LOGIN user per process
// role (app_api / app_voice / app_worker), kms-local with the SR-06 role grants, the fake SMS adapter, a manual clock
// and a captured log sink. Synthetic reserved-range phone numbers only.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createEphemeralKeyring, createLocalTokenSigningKey, type LocalKeyring } from '@hsp/adapter-kms-local';
import { createFakeSms, type FakeSms } from '@hsp/adapter-sms-fake';
import { ManualClock } from '@hsp/kernel';
import type { DiagnosisPolicy } from '@hsp/module-diagnosis';
import type { IdentityKeys } from '@hsp/module-identity';
import { createLogger } from '@hsp/observability';
import { MemoryRateLimitStore, type RateLimitStore } from '@hsp/security';
import { createTestDatabase, type TestDatabase } from '@hsp/testing';
import { composeApi, type ApiComposition } from '../bootstrap.ts';

export const ORIGIN = 'https://app.test.invalid';
/** The process environment the adapters' no-production guards check (Vitest itself adds DEV / PROD / MODE to process.env). */
export const TEST_ENV = { APP_ENV: 'test' } as const;
export const ISSUER = 'https://auth.test.invalid';

export interface ApiHarness {
  readonly db: TestDatabase;
  readonly clock: ManualClock;
  readonly sms: FakeSms;
  readonly logs: string[];
  readonly keyring: LocalKeyring;
  readonly keys: IdentityKeys;
  /** api role composition. */
  readonly api: ApiComposition;
  /** Other process roles over the same database, KMS and keys. */
  role(role: 'app_api' | 'app_voice' | 'app_worker', kmsRole: string): Promise<ApiComposition>;
  /** Technicians eligible for the technician app (stands in for the workforce module). */
  readonly technicians: Set<string>;
  /** Gate 6: signed quote links "delivered" to customers (fake comms): quote version id → token. */
  readonly quoteLinks: Map<string, string>;
  /** Gate 6: call sessions the fake telephony evidences (ops-desk bridged calls, recorded customer calls). */
  readonly calls: Set<string>;
  close(): Promise<void>;
}

export async function createApiHarness(opts: { rateLimitStore?: RateLimitStore; botTokens?: string[]; diagnosisPolicy?: DiagnosisPolicy } = {}): Promise<ApiHarness> {
  const db = await createTestDatabase();
  const clock = new ManualClock(new Date());
  const sms = createFakeSms(TEST_ENV);
  const logs: string[] = [];
  const logger = createLogger('hsp-api-test', 'debug', (l) => logs.push(l), () => clock.now());
  const keyring = createEphemeralKeyring(TEST_ENV);
  const signing = createLocalTokenSigningKey(`k-${randomUUID().slice(0, 8)}`, TEST_ENV);
  const keys: IdentityKeys = { otpPepper: randomBytes(32), blindIndexPepper: randomBytes(32), refreshRotationKey: randomBytes(32), csrfKey: randomBytes(32), requestHashKey: randomBytes(32) };
  const technicians = new Set<string>();
  const pools: pg.Pool[] = [];
  const bot = new Set(opts.botTokens ?? []);
  const rateLimitStore = opts.rateLimitStore ?? new MemoryRateLimitStore();
  const jobsCodeKey = randomBytes(32);
  const quoteLinks = new Map<string, string>();
  const calls = new Set<string>();

  const build = async (dbRole: 'app_api' | 'app_voice' | 'app_worker', kmsRole: string) => {
    const pool = new pg.Pool({ connectionString: await db.loginFor(dbRole), max: 5 });
    pools.push(pool);
    return composeApi({
      pool, clock, logger, kms: keyring.forRole(kmsRole), tokenSigner: signing.signer, tokenVerificationKeys: signing.publicKeys, issuer: ISSUER,
      keys, otpSender: sms.sender, eligibility: { isEligible: async (userId, surface) => surface === 'CUSTOMER_WEB' || technicians.has(userId) },
      botVerifier: { verify: async (t) => bot.has(t) }, phonePolicy: 'RESERVED_TEST_RANGE_ONLY', allowedWebOrigins: [ORIGIN], rateLimitStore, appEnv: 'test', jobsCodeKey,
      quoteLinkSender: { deliver: async (l) => { quoteLinks.set(l.quoteVersionId, l.token); } },
      callEvidence: { bridgedCall: async (id) => calls.has(id), recordedCustomerCall: async (id) => calls.has(id) },
      ...(opts.diagnosisPolicy ? { diagnosisPolicy: opts.diagnosisPolicy } : {}),
    });
  };
  const api = await build('app_api', 'api');
  return {
    db, clock, sms, logs, keyring, keys, api, technicians, quoteLinks, calls,
    role: (role, kmsRole) => build(role, kmsRole),
    async close() {
      for (const p of pools) await p.end();
      await db.close();
    },
  };
}

let ipCounter = 0;
/** A fresh client IP per call keeps the per-IP limits out of tests that aren't about them. */
export function meta(ip?: string) {
  ipCounter += 1;
  return { requestId: randomUUID(), clientIp: ip ?? `198.51.100.${ipCounter % 250}` };
}

let phoneCounter = 300;
/** Fresh synthetic phone in the reserved fake range (+91 0000 0xxxxx). */
export function testPhone(): string {
  phoneCounter += 1;
  return `+9100000${String(phoneCounter).padStart(5, '0')}`;
}
