import { describe, expect, it } from 'vitest';
import { baseEnvSchema, ConfigError, loadConfig } from '../env.ts';
import { bootstrapRole } from '../runtime.ts';

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const config = loadConfig(baseEnvSchema, { APP_ENV: 'dev', APP_ROLE: 'api' });
    expect(config).toMatchObject({ APP_ENV: 'dev', APP_ROLE: 'api', PORT: 8080, LOG_LEVEL: 'info' });
  });

  it('rejects unknown environments and roles and names the keys', () => {
    try {
      loadConfig(baseEnvSchema, { APP_ENV: 'prod', APP_ROLE: 'shell' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toMatch(/^APP_ENV:/m);
      expect(issues).toMatch(/^APP_ROLE:/m);
    }
  });

  it('never echoes values in error messages (values may be secrets)', () => {
    const secretLooking = 'sk_test_THIS_VALUE_MUST_NOT_APPEAR';
    try {
      loadConfig(baseEnvSchema, { APP_ENV: 'dev', APP_ROLE: 'api', AWS_ACCOUNT_ID: secretLooking });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secretLooking);
    }
  });

  it('only permits the Mumbai region', () => {
    expect(() => loadConfig(baseEnvSchema, { APP_ENV: 'dev', APP_ROLE: 'api', AWS_REGION: 'us-east-1' })).toThrow(ConfigError);
  });
});

describe('bootstrapRole', () => {
  it('refuses to start in a production-shaped environment', async () => {
    await expect(bootstrapRole('api', { APP_ENV: 'production', APP_ROLE: 'api' }, { installSignalHandlers: false })).rejects.toThrow(
      /no-production/,
    );
  });

  it('refuses a role mismatch', async () => {
    await expect(bootstrapRole('api', { APP_ENV: 'dev', APP_ROLE: 'worker', PORT: '0' }, { installSignalHandlers: false })).rejects.toThrow(
      /APP_ROLE mismatch/,
    );
  });

  it('serves an internal health endpoint after validating config', async () => {
    const running = await bootstrapRole('api', { APP_ENV: 'local', APP_ROLE: 'api', PORT: '0', LOG_LEVEL: 'error' }, { installSignalHandlers: false });
    try {
      const address = running.server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', role: 'api', env: 'local' });
      const missing = await fetch(`http://127.0.0.1:${address.port}/anything-else`);
      expect(missing.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
