// Supply-chain settings regression (ADR-022 #3, ADR-026 #3): the pnpm policies stay on, overrides stay the two
// documented transitive pins, and the lockfile never resolves the undici-types version the trust policy refused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8');
const lockfile = readFileSync(new URL('pnpm-lock.yaml', root), 'utf8');
const npmrc = readFileSync(new URL('.npmrc', root), 'utf8');

/** The `overrides:` block of a pnpm YAML file (simple two-space map). */
function overrides(yaml: string): Record<string, string> {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'overrides:');
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}(\S.*?):\s*(\S+)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) break;
    out[m[1].replace(/^'|'$/g, '')] = m[2];
  }
  return out;
}

describe('supply-chain policy', () => {
  it('trust, release-age, exotic-source and install-script controls are unchanged', () => {
    expect(workspace).toMatch(/^trustPolicy: no-downgrade$/m);
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(workspace).toMatch(/^blockExoticSubdeps: true$/m);
    expect(workspace).toMatch(/^onlyBuiltDependencies: \[\]$/m);
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
    expect(npmrc).toMatch(/^save-exact=true$/m);
  });

  it('overrides are exactly the two documented transitive pins, the Gate 5 one scoped to one graphile-config version', () => {
    const expected = { rolldown: '1.2.11', 'graphile-config@0.0.1-beta.18>@types/node': '24.13.6' };
    expect(overrides(workspace)).toEqual(expected);
    expect(overrides(lockfile)).toEqual(expected);
  });

  it('the lockfile resolves graphile-config to the pinned Node 24 types and never undici-types 6.21.0', () => {
    expect(lockfile).toContain('graphile-worker@0.18.0');
    expect(lockfile).not.toMatch(/undici-types@6\.21\.0/);
    const block = lockfile.split('\n  graphile-config@0.0.1-beta.18:\n')[2] ?? '';
    expect(block.split('\n\n')[0]).toContain("'@types/node': 24.13.6");
    expect(lockfile.match(/^ {2}'@types\/node@[^']+':$/gm)).toEqual(["  '@types/node@24.13.6':", "  '@types/node@24.13.6':"]);
  });
});
