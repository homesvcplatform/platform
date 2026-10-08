import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNoProd } from '../check-no-prod.mjs';
import { checkWorkspace } from '../../architecture/check-workspace.mjs';

const roots: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hsp-guard-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('no-production guardrail', () => {
  it('passes the real repository', () => {
    expect(checkNoProd(join(import.meta.dirname, '..', '..', '..'))).toEqual([]);
  });

  it.each([
    ['infra/envs/prod/main.tf', 'module "x" {}', /production-named directory/],
    ['infra/envs/dev/main.tf', 'environment = "prod"', /tf-environment-prod/],
    ['.env.example', 'APP_ENV=production', /app-env-prod/],
    ['.github/workflows/deploy.yml', 'jobs:\n  d:\n    environment: production\n', /gha-environment-prod/],
  ])('flags %s', (path, content, expected) => {
    const findings: string[] = checkNoProd(tree({ [path]: content }));
    expect(findings.join('\n')).toMatch(expected);
  });

  it('ignores docs, which legitimately discuss production', () => {
    expect(checkNoProd(tree({ 'docs/phase-1/14-deployment.md': 'APP_ENV=prod environment = "prod"' }))).toEqual([]);
  });
});

describe('workspace consistency check', () => {
  it('passes the real repository', () => {
    expect(checkWorkspace(join(import.meta.dirname, '..', '..', '..'))).toEqual([]);
  });
});
