// `pnpm run db:migrate`: applies db/migrations as the migrator role. Local / CI / dev / test only.
// Needs HSP_MIGRATOR_DATABASE_URL (the migrator login, never a superuser). Refuses production markers. Then installs the
// durable-timer queue schema (Graphile Worker, ADR-026 #3) as the same role.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertNonProduction } from '@hsp/kernel';
import { loadMigrations, runMigrations } from '../migrate.ts';
import { allSchemas, ownershipFromModulesJson } from '../query-guard.ts';
import { installTimerQueue } from '../timers.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertNonProduction(env);
  const url = env['HSP_MIGRATOR_DATABASE_URL'];
  if (!url) throw new Error('HSP_MIGRATOR_DATABASE_URL is required (connection for the migrator role)');
  const spec = JSON.parse(readFileSync(join(repoRoot, 'tools/architecture/modules.json'), 'utf8'));
  const migrations = loadMigrations(join(repoRoot, 'db/migrations'), allSchemas(ownershipFromModulesJson(spec)));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await runMigrations(client, migrations, { log: (line) => console.log(line) });
    console.log(`migrations: ${result.applied.length} applied, ${result.alreadyApplied} already applied`);
  } finally {
    await client.end();
  }
  await installTimerQueue(url); // ADR-026 #3: the timer queue schema, after the SQL migrations
  console.log('timer queue: installed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
