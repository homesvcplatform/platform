// Proves the boundary rules actually fire (Gate 1 exit criterion: "a deliberate boundary violation fails CI").
// Builds a throwaway tree that mirrors the repo layout, plants one violation per rule, runs
// dependency-cruiser with the real rule set, and asserts each planted violation is reported.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cruise } from 'dependency-cruiser';

const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs') as {
  forbidden: unknown[];
  options: Record<string, unknown>;
};

let root = '';
const file = (path: string, content: string): void => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

async function violations(): Promise<Violation[]> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = await cruise(['apps', 'packages'], {
      ruleSet: { forbidden: config.forbidden },
      validate: true,
      doNotFollow: { path: 'node_modules' },
      tsPreCompilationDeps: true,
      combinedDependencies: true,
    } as never);
    const output = result.output as unknown as { summary: { violations: Violation[] } };
    return output.summary.violations;
  } finally {
    process.chdir(previous);
  }
}

const ok = 'export const x = 1;\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsp-arch-'));
  // legitimate structure
  for (const m of ['jobs', 'diagnosis', 'payments', 'catalog', 'config', 'identity', 'comms']) {
    file(`packages/modules/${m}/src/public/index.ts`, ok);
    file(`packages/modules/${m}/src/domain/model.ts`, ok);
    file(`packages/modules/${m}/src/http/index.ts`, ok);
  }
  file('packages/kernel/src/index.ts', ok);
  file('packages/db/src/index.ts', ok);
  file('packages/contracts/src/index.ts', ok);
  file('packages/adapters/sms-fake/src/index.ts', ok);
  file('packages/adapters/kyc-fake/src/index.ts', ok);

  // allowed edges (must NOT be reported)
  file('packages/modules/diagnosis/src/application/allowed.ts', "import '../../../jobs/src/public/index.ts';\n");
  file('apps/api/src/main.ts', "import '../../../packages/modules/jobs/src/http/index.ts';\nimport '../../../packages/db/src/index.ts';\n");
  file('apps/web-bff/src/allowed.ts', "import '../../../packages/contracts/src/index.ts';\n");

  // planted violations
  file('packages/modules/jobs/src/application/b1-deep.ts', "import '../../../diagnosis/src/domain/model.ts';\n");
  file('packages/modules/jobs/src/application/b3-graph.ts', "import '../../../payments/src/public/index.ts';\n");
  file('packages/modules/identity/src/application/b3-cycle-risk.ts', "import '../../../comms/src/public/index.ts';\n");
  file('packages/kernel/src/b5.ts', "import '../../modules/jobs/src/public/index.ts';\n");
  file('packages/modules/catalog/src/application/b9.ts', "import '../../../../adapters/sms-fake/src/index.ts';\n");
  file('packages/adapters/sms-fake/src/b9-adapter.ts', "import '../../kyc-fake/src/index.ts';\n");
  file('apps/worker/src/b6-cross-app.ts', "import '../../api/src/main.ts';\n");
  file('apps/worker/src/b6-db.ts', "import '../../../packages/db/src/index.ts';\n");
  file('apps/web-bff/src/b7.ts', "import '../../../packages/kernel/src/index.ts';\n");
  file('apps/admin-web/src/b1-outside.ts', "import '../../../packages/modules/jobs/src/domain/model.ts';\n");
  file('packages/modules/config/src/application/cycle-a.ts', "import './cycle-b.ts';\n");
  file('packages/modules/config/src/application/cycle-b.ts', "import './cycle-a.ts';\n");
  file('packages/modules/jobs/src/application/unresolvable.ts', "import './does-not-exist.ts';\n");
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('architecture boundary rules', () => {
  let found: Violation[] = [];
  beforeAll(async () => {
    found = await violations();
  });

  const expectRule = (fromFile: string, rule: string): void => {
    const hit = found.find((v) => v.from.endsWith(fromFile) && v.rule.name === rule);
    expect(hit, `expected ${rule} for ${fromFile}; got ${JSON.stringify(found.map((v) => [v.from, v.rule.name]))}`).toBeDefined();
  };

  it('B1: blocks deep imports into another module', () => expectRule('jobs/src/application/b1-deep.ts', 'B1-no-deep-import-from-other-module'));
  it('B1: blocks deep imports from apps', () => expectRule('admin-web/src/b1-outside.ts', 'B1-no-deep-import-from-outside-modules'));
  it('B3: blocks module edges not in the approved graph (jobs -> payments)', () =>
    expectRule('jobs/src/application/b3-graph.ts', 'B3-module-graph-jobs'));
  it('B3: identity may not import comms (ADR-022 OtpSender port instead)', () =>
    expectRule('identity/src/application/b3-cycle-risk.ts', 'B3-module-graph-identity'));
  it('B5: shared packages may not import modules', () => expectRule('kernel/src/b5.ts', 'B5-shared-packages-do-not-import-modules'));
  it('B9: modules may not import adapters', () => expectRule('catalog/src/application/b9.ts', 'B9-modules-do-not-import-adapters-or-apps'));
  it('B9: adapters may not import other adapters', () =>
    expectRule('sms-fake/src/b9-adapter.ts', 'B9-adapters-do-not-import-apps-or-other-adapters'));
  it('B6: apps may not import other apps', () => expectRule('worker/src/b6-cross-app.ts', 'B6-apps-do-not-import-other-apps'));
  it('B6: app code outside bootstrap may not use @hsp/db', () => expectRule('worker/src/b6-db.ts', 'B6-apps-do-not-use-db-directly'));
  it('B7: frontends may import only client-safe packages', () => expectRule('web-bff/src/b7.ts', 'B7-frontends-import-only-client-safe-packages'));
  it('detects dependency cycles', () => expectRule('config/src/application/cycle-a.ts', 'no-circular'));
  it('detects unresolvable imports', () => expectRule('jobs/src/application/unresolvable.ts', 'not-to-unresolvable'));

  it('does not flag approved edges', () => {
    const falsePositives = found.filter(
      (v) => v.from.endsWith('allowed.ts') || (v.from.endsWith('apps/api/src/main.ts') && v.rule.name !== 'no-circular'),
    );
    expect(falsePositives).toEqual([]);
  });
});
