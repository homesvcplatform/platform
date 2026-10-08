# Architecture boundary enforcement

Single source of truth: `modules.json` (modules, schemas, allowed compile-time dependencies, TCPs).
`.dependency-cruiser.cjs` is generated from it at run time. `check-workspace.mjs` verifies the workspace matches it.

| Rule | What | Enforced by | Status |
|---|---|---|---|
| B1 | Modules import other modules only via `public` (apps may also use `http`) | package `exports` maps, dependency-cruiser `B1-*`, ESLint `no-restricted-imports`, `check-workspace` | **Active (Gate 1)** |
| B2 | No module touches another module's tables | Query-tag fitness test | Gate 2 (needs `@hsp/db`) |
| B3 | Module edges follow the approved graph, no cycles | dependency-cruiser `B3-module-graph-*`, `no-circular` | **Active (Gate 1)** |
| B4 | Cross-module transactions only at TCP-1/2/3 | Unit-of-work nesting fitness test | Gate 2/5 |
| B5 | Shared packages never import modules/adapters/apps | dependency-cruiser `B5-*` | **Active (Gate 1)** |
| B6 | Apps are wiring only (no cross-app imports, no direct DB use outside bootstrap) | dependency-cruiser `B6-*` | **Active (Gate 1)** |
| B7 | Frontends import only client-safe packages | dependency-cruiser `B7-*` | **Active (Gate 1)**. Server-side BFF exception at Gate 3 |
| B8 | No secrets in source or frontends | gitleaks (CI, blocking + self-test), `.gitignore`, PR checklist. Bundle secret scan at Gate 8 | **Active (Gate 1)** |
| B9 | Modules never import adapters; adapters never import apps/other adapters | dependency-cruiser `B9-*` | **Active (Gate 1)** |
| B10 | Only the worker role writes the ledger | DB grants + grant-matrix test | Gate 2 |
| B11 | Every HTTP handler declares a policy | Policy registry boot check | Gate 3 |
| B12 | Every mutating endpoint declares idempotency | Contract metadata check | Gate 3 |

`__tests__/boundaries.test.ts` plants one violation per active rule in a throwaway tree and asserts each is reported.
