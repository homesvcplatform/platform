// `pnpm run db:seed`: loads synthetic fixtures. Refuses production markers and any environment other than
// local / dev / test. Needs HSP_MIGRATOR_DATABASE_URL (the schema owner; seeds bypass runtime role limits on purpose).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertNonProduction } from '@hsp/kernel';
import { loadSyntheticSeed } from './load.ts';

const SEEDABLE = new Set(['local', 'dev', 'test']);

export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  assertNonProduction(env);
  const appEnv = (env['APP_ENV'] ?? '').trim().toLowerCase();
  if (!SEEDABLE.has(appEnv)) throw new Error(`synthetic seeds load only when APP_ENV is local, dev or test (got "${appEnv || 'unset'}")`);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertSeedAllowed(env);
  const url = env['HSP_MIGRATOR_DATABASE_URL'];
  if (!url) throw new Error('HSP_MIGRATOR_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const summary = await loadSyntheticSeed(client);
    await client.query('COMMIT');
    console.log(`synthetic seed loaded (${summary.statements} idempotent statements)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
