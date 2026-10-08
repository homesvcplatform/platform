// No-production guardrails (Phase 2 constraints 3, 4, 6, 7 and 02 §4).
// These run before config parsing so a production-shaped environment fails with an explicit reason.

export class GuardrailError extends Error {
  readonly guard: string;
  constructor(guard: string, message: string) {
    super(`[${guard}] ${message}`);
    this.name = 'GuardrailError';
    this.guard = guard;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const PRODUCTION_ALIASES: ReadonlySet<string> = new Set(['prod', 'production', 'prd', 'live']);
/** Environment variable names that indicate production credentials or wiring. */
const PRODUCTION_MARKER = /(^|_)(PROD|PRODUCTION|LIVE)(_|$)/;

export function assertNonProduction(env: Env): void {
  const appEnv = (env['APP_ENV'] ?? '').trim().toLowerCase();
  if (PRODUCTION_ALIASES.has(appEnv)) {
    throw new GuardrailError('no-production', 'Phase 2 has no production environment. Refusing to start.');
  }
  const markers = Object.keys(env).filter((key) => PRODUCTION_MARKER.test(key.toUpperCase()));
  if (markers.length > 0) {
    throw new GuardrailError('no-production-credentials', `Production-marked variables present: ${markers.join(', ')}`);
  }
  const accountId = env['AWS_ACCOUNT_ID'];
  if (accountId !== undefined && accountId !== '') {
    const allowed = (env['NONPROD_AWS_ACCOUNT_IDS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (!allowed.includes(accountId)) {
      throw new GuardrailError('non-production-account', 'AWS_ACCOUNT_ID is not in NONPROD_AWS_ACCOUNT_IDS.');
    }
  }
}

/**
 * Real provider adapters (telephony, payments, KYC, AI, SMS...) may load only in test/staging with
 * sandbox credentials and an explicit per-provider flag. Phase 2 / 02 §4.
 */
export function assertExternalAdapterAllowed(provider: string, env: Env): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(provider)) {
    throw new GuardrailError('external-adapter', 'Provider ids must be lower_snake_case.');
  }
  assertNonProduction(env);
  const appEnv = env['APP_ENV'];
  if (appEnv !== 'test' && appEnv !== 'staging') {
    throw new GuardrailError('external-adapter', `Real provider "${provider}" may only load in test or staging.`);
  }
  const flag = `ALLOW_EXTERNAL_${provider.toUpperCase()}`;
  if (env[flag] !== 'true') {
    throw new GuardrailError('external-adapter', `Real provider "${provider}" requires ${flag}=true.`);
  }
}

/** Production IVR state changes stay disabled until Spike S-1 passes (SR-01). No override exists in Phase 2. */
export function ivrProductionStateChangesEnabled(): false {
  return false;
}
