import { describe, expect, it } from 'vitest';
import { assertExternalAdapterAllowed, assertNonProduction, GuardrailError, ivrProductionStateChangesEnabled } from '../guards.ts';

describe('assertNonProduction (no-production guardrail)', () => {
  it.each(['prod', 'production', 'PROD', ' Production ', 'prd', 'live'])('refuses APP_ENV=%s', (value) => {
    expect(() => assertNonProduction({ APP_ENV: value })).toThrow(GuardrailError);
  });

  it.each(['local', 'dev', 'test', 'staging'])('allows APP_ENV=%s', (value) => {
    expect(() => assertNonProduction({ APP_ENV: value })).not.toThrow();
  });

  it.each(['PROD_DATABASE_URL', 'PA_LIVE_KEY', 'TELEPHONY_PRODUCTION_TOKEN', 'prod_secret'])(
    'refuses production-marked variable %s',
    (key) => {
      expect(() => assertNonProduction({ APP_ENV: 'dev', [key]: 'x' })).toThrow(/no-production-credentials/);
    },
  );

  it('does not flag words that merely contain the letters (e.g. PRODUCT_CATALOG_URL)', () => {
    expect(() => assertNonProduction({ APP_ENV: 'dev', PRODUCT_CATALOG_URL: 'x', DELIVERY_LIVENESS: 'x' })).not.toThrow();
  });

  it('refuses an AWS account that is not on the non-production allowlist', () => {
    expect(() =>
      assertNonProduction({ APP_ENV: 'dev', AWS_ACCOUNT_ID: '111111111111', NONPROD_AWS_ACCOUNT_IDS: '222222222222' }),
    ).toThrow(/non-production-account/);
    expect(() => assertNonProduction({ APP_ENV: 'dev', AWS_ACCOUNT_ID: '111111111111' })).toThrow(/non-production-account/);
  });

  it('allows an allowlisted non-production AWS account', () => {
    expect(() =>
      assertNonProduction({ APP_ENV: 'dev', AWS_ACCOUNT_ID: '222222222222', NONPROD_AWS_ACCOUNT_IDS: '111111111111, 222222222222' }),
    ).not.toThrow();
  });
});

describe('assertExternalAdapterAllowed (no production providers)', () => {
  it('refuses real providers in local and dev', () => {
    expect(() => assertExternalAdapterAllowed('telephony_a', { APP_ENV: 'local', ALLOW_EXTERNAL_TELEPHONY_A: 'true' })).toThrow();
    expect(() => assertExternalAdapterAllowed('telephony_a', { APP_ENV: 'dev', ALLOW_EXTERNAL_TELEPHONY_A: 'true' })).toThrow();
  });

  it('requires the explicit per-provider flag in test/staging', () => {
    expect(() => assertExternalAdapterAllowed('pa_sandbox', { APP_ENV: 'test' })).toThrow(/ALLOW_EXTERNAL_PA_SANDBOX/);
    expect(() => assertExternalAdapterAllowed('pa_sandbox', { APP_ENV: 'staging', ALLOW_EXTERNAL_PA_SANDBOX: 'yes' })).toThrow();
  });

  it('allows a flagged provider in test/staging', () => {
    expect(() => assertExternalAdapterAllowed('pa_sandbox', { APP_ENV: 'test', ALLOW_EXTERNAL_PA_SANDBOX: 'true' })).not.toThrow();
    expect(() => assertExternalAdapterAllowed('pa_sandbox', { APP_ENV: 'staging', ALLOW_EXTERNAL_PA_SANDBOX: 'true' })).not.toThrow();
  });

  it('still refuses when production markers are present', () => {
    expect(() =>
      assertExternalAdapterAllowed('pa_sandbox', { APP_ENV: 'test', ALLOW_EXTERNAL_PA_SANDBOX: 'true', PA_LIVE_KEY: 'x' }),
    ).toThrow(/no-production-credentials/);
  });
});

describe('IVR production state changes (SR-01)', () => {
  it('are hard-disabled in Phase 2', () => {
    expect(ivrProductionStateChangesEnabled()).toBe(false);
  });
});
