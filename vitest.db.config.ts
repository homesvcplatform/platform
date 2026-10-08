// Database tests (Gates 2-3) (`pnpm run test:db`). They need HSP_TEST_DB_ADMIN_URL pointing at a THROWAWAY PostgreSQL 17 +
// PostGIS instance (the CI service container) and fail loudly without it. Files run one at a time because each one
// bootstraps cluster-wide roles before creating its own database.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.db.test.ts', 'apps/**/src/**/*.db.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
