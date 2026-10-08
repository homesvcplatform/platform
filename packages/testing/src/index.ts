// @hsp/testing: synthetic fixtures (Kurnool pilot, fictional), seed loader, fixture-only crypto, DB test harness.
// Test-only: runtime code must never import this package (dependency-cruiser rule no-test-code-in-runtime).
export { asRole, createTestDatabase, inRollback, knownSchemas, repoMigrations, sqlState, sqlStateAtCommit } from './db-harness.ts';
export type { TestDatabase } from './db-harness.ts';
export * as kurnool from './fixtures/kurnool.ts';
export { blindIndexFixture, decryptFixture, encryptFixture, FIXTURE_KEY_REF, isReservedTestPhone, maskPhone } from './fixtures/synthetic-crypto.ts';
export { loadSyntheticSeed } from './seed/load.ts';
export type { SeedSummary } from './seed/load.ts';
