// Process-role bootstrap (Gate 1): guardrails -> config validation -> internal health endpoint.
// Business wiring is added per gate; this file stays free of domain logic (B6).
import { createServer, type Server } from 'node:http';
import { createLogger } from '@hsp/observability';
import { baseEnvSchema, loadConfig, type BaseEnv, type ProcessRole } from './env.ts';
import { assertNonProduction } from './guards.ts';

export interface RunningRole {
  readonly config: BaseEnv;
  readonly server: Server;
  close(): Promise<void>;
}

export async function bootstrapRole(
  role: ProcessRole,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly installSignalHandlers?: boolean } = {},
): Promise<RunningRole> {
  assertNonProduction(env);
  const config = loadConfig(baseEnvSchema, env);
  if (config.APP_ROLE !== role) {
    throw new Error(`APP_ROLE mismatch: entrypoint is "${role}"`);
  }
  const logger = createLogger(`hsp-${role}`, config.LOG_LEVEL);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', role, env: config.APP_ENV }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(config.PORT, resolve));
  logger.log('info', 'role.started', { role, appEnv: config.APP_ENV, port: config.PORT });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (options.installSignalHandlers ?? true) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        logger.log('info', 'role.stopping', { role, signal });
        void close().then(() => process.exit(0));
      });
    }
  }
  return { config, server, close };
}
