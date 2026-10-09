// Gate 4 exit criterion "no category / service-type string literals in app code" (ADR-025 #11): the lint rule fires on
// planted literals in app, module and UI code, spares tests and fixtures, and its code list equals the fixture tree.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { CATEGORIES, SERVICE_TYPES } from '../../../packages/testing/src/fixtures/kurnool.ts';

const root = new URL('../../../', import.meta.url);
const codes = JSON.parse(readFileSync(new URL('tools/architecture/catalog-codes.json', root), 'utf8')) as { categories: string[]; serviceTypes: string[] };
const eslint = new ESLint({ cwd: decodeURIComponent(root.pathname.replace(/^\/([A-Za-z]:)/, '$1')) });

async function catalogCodeErrors(filePath: string, text: string): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('Catalog category')).length;
}

describe('catalog-code lint rule', () => {
  it('lists exactly the categories and service types of the catalog tree', () => {
    expect([...codes.categories].sort()).toEqual(CATEGORIES.map((c) => c.code).sort());
    expect([...codes.serviceTypes].sort()).toEqual(SERVICE_TYPES.map((t) => t.code).sort());
  });

  it.each([
    ['apps/api/src/planted.ts', "export const kind = 'REFRIGERATOR';\n"],
    ['apps/admin-api/src/planted.ts', 'export const kind = `APPLIANCE_HOME_EQUIPMENT`;\n'],
    ['packages/modules/matching/src/domain/planted.ts', "export const isAc = (code: string) => code === 'AC';\n"],
    ['packages/ui-web/src/planted.ts', "export const label = { PLUMBING_GENERAL: 'x', kind: 'PLUMBING' };\n"],
  ])('rejects a hard-coded code in %s', async (filePath, text) => {
    expect(await catalogCodeErrors(filePath, text)).toBe(1);
  });

  it.each([
    ['apps/api/src/__tests__/planted.test.ts', "export const kind = 'REFRIGERATOR';\n"],
    ['packages/testing/src/fixtures/planted.ts', "export const kind = 'REFRIGERATOR';\n"],
    ['apps/api/src/planted.ts', "export const other = 'REFRIGERATOR_X'; export const t = `AC ${1}`;\n"],
  ])('allows %s (tests, fixtures, non-matching text)', async (filePath, text) => {
    expect(await catalogCodeErrors(filePath, text)).toBe(0);
  });
});
