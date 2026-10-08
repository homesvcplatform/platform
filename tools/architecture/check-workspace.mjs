#!/usr/bin/env node
// Workspace consistency check (B1, B8, B12-prep): every package matches tools/architecture/modules.json,
// uses the approved neutral @hsp/* namespace (ADR-021), exposes only approved entry points, pins exact
// external versions, and declares no install lifecycle scripts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listDirs(path) {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
}

export function checkWorkspace(root) {
  const errors = [];
  const spec = readJson(join(root, 'tools/architecture/modules.json'));
  const expect = (cond, msg) => { if (!cond) errors.push(msg); };

  const groups = [
    { dir: 'packages/modules', names: Object.keys(spec.modules), prefix: '@hsp/module-', exports: { '.': './src/public/index.ts', './http': './src/http/index.ts' } },
    { dir: 'packages/adapters', names: spec.adapters, prefix: '@hsp/adapter-', exports: { '.': './src/index.ts' } },
    { dir: 'apps', names: [...spec.backendApps, ...spec.frontendApps], prefix: '@hsp/app-', exports: undefined },
  ];
  const sharedNames = spec.sharedPackages;
  const presentShared = listDirs(join(root, 'packages')).filter((d) => d !== 'modules' && d !== 'adapters');
  for (const n of presentShared) expect(sharedNames.includes(n), `packages/${n} is not declared in modules.json sharedPackages`);
  for (const n of sharedNames) expect(presentShared.includes(n), `shared package packages/${n} is missing`);
  groups.push({ dir: 'packages', names: sharedNames, prefix: '@hsp/', exports: { '.': './src/index.ts' } });

  for (const group of groups) {
    const present = group.dir === 'packages' ? presentShared : listDirs(join(root, group.dir));
    for (const n of present) expect(group.names.includes(n), `${group.dir}/${n} is not declared in modules.json`);
    for (const n of group.names) {
      const pkgPath = join(root, group.dir, n, 'package.json');
      if (!existsSync(pkgPath)) { errors.push(`${group.dir}/${n}/package.json is missing`); continue; }
      const pkg = readJson(pkgPath);
      const where = relative(root, pkgPath).replaceAll('\\', '/');
      expect(pkg.name === `${group.prefix}${n}`, `${where}: name must be ${group.prefix}${n} (ADR-021 namespace)`);
      expect(pkg.private === true, `${where}: must be private`);
      if (group.exports) {
        expect(JSON.stringify(pkg.exports) === JSON.stringify(group.exports), `${where}: exports must be exactly ${JSON.stringify(group.exports)} (B1)`);
        expect(pkg.main === undefined && pkg.module === undefined, `${where}: use "exports" only (no main/module fields)`);
      }
      for (const script of LIFECYCLE) expect(!pkg.scripts?.[script], `${where}: lifecycle script "${script}" is not allowed`);
      for (const [dep, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (dep.startsWith('@hsp/')) expect(version === 'workspace:*', `${where}: ${dep} must use workspace:*`);
        else expect(EXACT_VERSION.test(version), `${where}: ${dep}@${version} must be pinned to an exact version`);
      }
    }
  }

  const rootPkg = readJson(join(root, 'package.json'));
  for (const [dep, version] of Object.entries(rootPkg.devDependencies ?? {})) {
    expect(EXACT_VERSION.test(version), `package.json: ${dep}@${version} must be pinned to an exact version`);
  }
  for (const script of LIFECYCLE) expect(!rootPkg.scripts?.[script], `package.json: lifecycle script "${script}" is not allowed`);
  expect(/^pnpm@\d+\.\d+\.\d+$/.test(rootPkg.packageManager ?? ''), 'package.json: packageManager must pin an exact pnpm version');
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const errors = checkWorkspace(root);
  if (errors.length > 0) {
    console.error(`Workspace check FAILED (${errors.length}):\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log('Workspace check passed: packages match modules.json, exports locked, versions pinned, no lifecycle scripts.');
}
