// Gate 1 deploy-control tests (SR-16): task definitions are digest-pinned and hardened; the image verifier
// refuses anything that is not referenced by digest. (Signature verification itself needs cosign + a registry
// and is exercised by the supply-chain-selftest CI job.)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..');
const digestRef = `123456789012.dkr.ecr.ap-south-1.amazonaws.com/hsp-dev-backend@sha256:${'a'.repeat(64)}`;
const env = { ...process.env, AWS_ACCOUNT_ID: '123456789012', TASK_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/hsp-dev-task-execution' };

function render(args: string[]) {
  return spawnSync(process.execPath, [join(dir, 'render-task-definition.mjs'), ...args], { env, encoding: 'utf8' });
}

describe('render-task-definition', () => {
  it('renders a hardened, digest-pinned Fargate task definition', () => {
    const result = render(['dev', 'api', digestRef]);
    expect(result.status).toBe(0);
    const td = JSON.parse(result.stdout);
    const container = td.containerDefinitions[0];
    expect(container.image).toBe(digestRef);
    expect(container.user).toBe('65532:65532');
    expect(container.readonlyRootFilesystem).toBe(true);
    expect(container.linuxParameters.capabilities.drop).toEqual(['ALL']);
    expect(container.command).toEqual(['apps/api/src/main.ts']);
    expect(container.environment).toContainEqual({ name: 'APP_ENV', value: 'dev' });
    expect(td.taskRoleArn).toBe('arn:aws:iam::123456789012:role/hsp-dev-api-task');
  });

  it.each([
    [['prod', 'api', digestRef], /dev or test/],
    [['production', 'api', digestRef], /dev or test/],
    [['dev', 'shell', digestRef], /unknown role/],
    [['dev', 'api', 'repo:latest'], /pinned by digest/],
  ])('refuses %j', (args, message) => {
    const result = render(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });
});

describe('verify-image.sh', () => {
  it.each(['repo:latest', 'repo:v1.2.3', 'repo@sha256:short'])('refuses non-digest reference %s', (ref) => {
    const result = spawnSync('bash', [join(dir, 'verify-image.sh'), ref], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'homesvcplatform/platform' } });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/REFUSED: image must be referenced by an immutable sha256 digest/);
  });

  it('refuses a digest reference when the signature does not verify (fails closed)', () => {
    // A stand-in cosign that rejects every signature, so the test is deterministic and offline.
    const shimDir = mkdtempSync(join(tmpdir(), 'hsp-cosign-'));
    writeFileSync(join(shimDir, 'cosign'), '#!/usr/bin/env bash\necho "no matching signatures" >&2\nexit 1\n', { mode: 0o755 });
    try {
      const result = spawnSync('bash', ['-c', `PATH="${shimDir.replaceAll('\\', '/')}:$PATH" bash "$0" "$1"`, join(dir, 'verify-image.sh'), digestRef], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REPOSITORY: 'homesvcplatform/platform' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/REFUSED: no valid signature/);
      expect(result.stdout).not.toMatch(/VERIFIED/);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
