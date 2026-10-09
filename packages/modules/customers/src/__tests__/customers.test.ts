// Gate 5: customers SQL ownership (B2). Address reads are exercised end to end in the api DB tests.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson } from '@hsp/db';
import { CUSTOMERS_SQL } from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));

describe('B2: customers SQL touches only its own schema', () => {
  it('every statement', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(CUSTOMERS_SQL)) expect(() => assertModuleOwnsSql('customers', sql, ownership), name).not.toThrow();
  });
});
