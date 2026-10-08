import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tools/**/__tests__/**/*.test.ts'],
    // Database tests need a throwaway PostgreSQL + PostGIS: they run via `pnpm run test:db` (vitest.db.config.ts).
    exclude: ['**/node_modules/**', '**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
