import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSqlOwnership } from '../check-sql-ownership.mjs';

const repoModules = new URL('../modules.json', import.meta.url);
const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hsp-b2-'));
  dirs.push(root);
  mkdirSync(join(root, 'tools/architecture'), { recursive: true });
  cpSync(repoModules, join(root, 'tools/architecture/modules.json'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('B2 static SQL ownership check', () => {
  it('passes on the real repository', () => {
    expect(checkSqlOwnership(fileURLToPath(new URL('../../../', import.meta.url)))).toEqual([]);
  });

  it('flags a module that queries another module\'s tables', () => {
    const root = tree({
      'packages/modules/jobs/src/infrastructure/repo.ts': "export const q = 'SELECT * FROM diagnosis.quotes WHERE job_id = $1';",
    });
    expect(checkSqlOwnership(root)).toEqual(['packages/modules/jobs/src/infrastructure/repo.ts:1: module "jobs" SQL references diagnosis']);
  });

  it('flags ledger access from outside payments, and multi-line template SQL', () => {
    const root = tree({
      'packages/modules/matching/src/infrastructure/repo.ts': 'export const q = `\n  INSERT INTO ledger.entries (transaction_id)\n  VALUES ($1)`;',
    });
    expect(checkSqlOwnership(root)).toHaveLength(1);
  });

  it('allows own schemas, platform, payments->ledger, and ignores non-SQL strings and tests', () => {
    const root = tree({
      'packages/modules/jobs/src/infrastructure/repo.ts':
        "export const a = 'UPDATE jobs.visits SET status = $1';\nexport const b = 'INSERT INTO platform.outbox (id) VALUES ($1)';\nexport const e = 'jobs.VisitAssigned';",
      'packages/modules/payments/src/infrastructure/ledger.ts': "export const l = 'INSERT INTO ledger.entries (transaction_id) VALUES ($1)';",
      'packages/modules/jobs/src/__tests__/x.test.ts': "export const t = 'SELECT * FROM diagnosis.quotes';",
    });
    expect(checkSqlOwnership(root)).toEqual([]);
  });
});
