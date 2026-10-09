// IaC self-test regression (Gate 1 G-checks, fix f24d451): Checkov auto-loads `.checkov.yaml` from the repository root
// for every run, including the self-test of the planted insecure fixture. A `skip-path` / `skip-check` there would hide
// the fixture (Dependabot PR #1, branched before f24d451, still had `skip-path: [.selftest]` and its self-test found 0
// failures). Skips belong inline next to the resource. This test also keeps the real scan blocking and the self-test
// meaningful.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const checkovConfig = readFileSync(new URL('.checkov.yaml', root), 'utf8');
const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
const iacJob = ci.slice(ci.indexOf('\n  iac:\n'), ci.indexOf('\n  image:\n'));

/** The `with:` block of the workflow step whose name starts with `name`. */
function stepWith(name: string): string {
  const start = iacJob.indexOf(`- name: ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = iacJob.indexOf('\n      - ', start + 1);
  return iacJob.slice(start, next === -1 ? undefined : next);
}

describe('Checkov configuration', () => {
  it('.checkov.yaml skips nothing (no skip-path / skip-check; skips are inline with a justification)', () => {
    const keys = checkovConfig.split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).not.toContain('skip-path');
    expect(keys).not.toContain('skip-check');
    expect(keys).not.toContain('soft-fail');
    expect(checkovConfig.replace(/^#.*$/gm, '')).not.toMatch(/selftest/i);
  });
});

describe('iac job', () => {
  it('the real infrastructure scan is blocking and uses the repository config', () => {
    const real = stepWith('Checkov (blocking)');
    expect(real).toMatch(/directory: infra\b/);
    expect(real).toMatch(/config_file: \.checkov\.yaml/);
    expect(real).toMatch(/soft_fail: false/);
    expect(real).not.toMatch(/skip_check|skip_path/);
  });

  it('the planted fixture contains configurations Checkov must flag (public S3 access, SSH from 0.0.0.0/0)', () => {
    const fixture = stepWith('Prepare self-test fixture');
    for (const field of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
      expect(fixture).toMatch(new RegExp(`${field}\\s*=\\s*false`));
    }
    expect(fixture).toMatch(/from_port\s*=\s*22/);
    expect(fixture).toMatch(/cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/);
  });

  it('only the self-test may soft-fail, and the job fails unless the self-test reports failures', () => {
    const selftest = stepWith('Self-test - Checkov MUST fail the insecure fixture');
    expect(selftest).toMatch(/directory: \.selftest\/insecure-tf/);
    expect(selftest).toMatch(/soft_fail: true/);
    expect(selftest).not.toMatch(/skip_check|skip_path/);
    expect(iacJob.match(/soft_fail: true/g)).toHaveLength(1);
    const assert = stepWith('Assert the self-test produced failures');
    expect(assert).toMatch(/"\$failed" -eq 0/);
    expect(assert).toMatch(/exit 1/);
  });
});
