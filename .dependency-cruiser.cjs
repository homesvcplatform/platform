/**
 * Architecture boundary rules (Phase 2 / 02 §3, B1–B9). Generated from tools/architecture/modules.json
 * so the allowed module graph has one source of truth. Every rule is severity "error": violations fail CI.
 * Rules that need later gates (B2 query tagging, B4 TCP transaction allowlist, B10 ledger grants,
 * B11 policy registry, B12 idempotency metadata) are listed in tools/architecture/README.md.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const spec = JSON.parse(readFileSync(join(__dirname, 'tools/architecture/modules.json'), 'utf8'));
const moduleNames = Object.keys(spec.modules);
const shared = spec.sharedPackages.join('|');
const frontendApps = spec.frontendApps.join('|');
const frontendAllowed = spec.frontendAllowedPackages.join('|');

/** B3: each module may import only itself and its allowed dependencies (public entries). */
const moduleGraphRules = moduleNames.map((name) => {
  const allowed = [name, ...spec.modules[name].allowedDeps].join('|');
  return {
    name: `B3-module-graph-${name}`,
    comment: `Module "${name}" may depend only on: ${spec.modules[name].allowedDeps.join(', ') || '(nothing)'} (Phase 1 01 §4.3 + ADR-022).`,
    severity: 'error',
    from: { path: `^packages/modules/${name}/` },
    to: { path: '^packages/modules/([^/]+)/', pathNot: `^packages/modules/(${allowed})/` },
  };
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Dependency cycles are forbidden (Phase 1 01 §4.1 rule 7).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Imports must resolve (deep imports into packages are blocked by package "exports" maps).',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'B1-no-deep-import-from-other-module',
      severity: 'error',
      comment: 'A module may import another module only via its public entry (src/public).',
      from: { path: '^packages/modules/([^/]+)/' },
      to: { path: '^packages/modules/([^/]+)/src/(?!public/)', pathNot: '^packages/modules/$1/' },
    },
    {
      name: 'B1-no-deep-import-from-outside-modules',
      severity: 'error',
      comment: 'Apps, adapters and shared packages may import modules only via src/public (apps also src/http).',
      from: { pathNot: '^packages/modules/' },
      to: { path: '^packages/modules/[^/]+/src/(?!public/|http/)' },
    },
    {
      name: 'B1-only-apps-import-http',
      severity: 'error',
      comment: 'Module HTTP controllers are registered by apps only.',
      from: { pathNot: '^apps/' },
      to: { path: '^packages/modules/([^/]+)/src/http/', pathNot: '^packages/modules/$1/' },
    },
    ...moduleGraphRules,
    {
      name: 'B5-shared-packages-do-not-import-modules',
      severity: 'error',
      comment: 'Kernel/shared packages never import modules, adapters or apps.',
      from: { path: `^packages/(${shared})/` },
      to: { path: '^(packages/modules|packages/adapters|apps)/' },
    },
    {
      name: 'B9-modules-do-not-import-adapters-or-apps',
      severity: 'error',
      comment: 'Modules declare ports; adapters implement them; apps wire them.',
      from: { path: '^packages/modules/' },
      to: { path: '^(packages/adapters|apps)/' },
    },
    {
      name: 'B9-adapters-do-not-import-apps-or-other-adapters',
      severity: 'error',
      from: { path: '^packages/adapters/([^/]+)/' },
      to: { path: '^(apps/|packages/adapters/)', pathNot: '^packages/adapters/$1/' },
    },
    {
      name: 'B6-apps-do-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'B6-apps-do-not-use-db-directly',
      severity: 'error',
      comment: 'Apps contain wiring only; SQL lives in module infrastructure. Bootstrap files may create pools.',
      from: { path: '^apps/[^/]+/src/', pathNot: '^apps/[^/]+/src/(main|bootstrap[^/]*)\\.ts$' },
      to: { path: '^packages/db/' },
    },
    {
      name: 'B7-frontends-import-only-client-safe-packages',
      severity: 'error',
      comment: 'Frontend bundles may import only contracts, design tokens, UI kits, localization and money formatting.',
      from: { path: `^apps/(${frontendApps})/` },
      to: { path: '^(packages|apps)/', pathNot: [`^packages/(${frontendAllowed})/`, `^apps/(${frontendApps})/`] },
    },
    {
      name: 'no-test-code-in-runtime',
      severity: 'error',
      comment: 'Runtime code must not import tests or @hsp/testing.',
      from: { path: '^(apps|packages)/', pathNot: ['/__tests__/', '\\.test\\.ts$', '^packages/testing/'] },
      to: { path: ['/__tests__/', '\\.test\\.ts$', '^packages/testing/'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['node_modules', '(^|/)\\.turbo/', '(^|/)coverage/'] },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    preserveSymlinks: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
