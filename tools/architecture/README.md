# Architecture boundary enforcement

Single source of truth: `modules.json` (modules, schemas, allowed compile-time dependencies, TCPs).
`.dependency-cruiser.cjs` is generated from it at run time. `check-workspace.mjs` verifies the workspace matches it.

| Rule | What | Enforced by | Status |
|---|---|---|---|
| B1 | Modules import other modules only via `public` (apps may also use `http`) | package `exports` maps, dependency-cruiser `B1-*`, ESLint `no-restricted-imports`, `check-workspace` | **Active (Gate 1)** |
| B2 | No module touches another module's tables | Runtime guard `assertModuleOwnsSql` in `@hsp/db` (every module statement) + static `check-sql-ownership.mjs` (`pnpm run guard:sql-ownership`, in `pnpm run ci`) | **Active (Gate 2)** |
| B3 | Module edges follow the approved graph, no cycles | dependency-cruiser `B3-module-graph-*`, `no-circular` | **Active (Gate 1)** |
| B4 | Cross-module transactions only at TCP-1/2/3 | `UnitOfWork.join` in `@hsp/db` refuses any other cross-module join (unit-tested). Enforced on real call sites once module repositories exist (Gate 3/5) | **Mechanism active (Gate 2)** |
| B5 | Shared packages never import modules/adapters/apps | dependency-cruiser `B5-*` | **Active (Gate 1)** |
| B6 | Apps are wiring only (no cross-app imports, no direct DB use outside bootstrap) | dependency-cruiser `B6-*` | **Active (Gate 1)** |
| B7 | Frontends import only client-safe packages | dependency-cruiser `B7-*` | **Active (Gate 1)**. Server-side BFF exception at Gate 3 |
| B8 | No secrets in source or frontends | gitleaks (CI, blocking + self-test), `.gitignore`, PR checklist. Bundle secret scan at Gate 8 | **Active (Gate 1)** |
| B9 | Modules never import adapters; adapters never import apps/other adapters | dependency-cruiser `B9-*` | **Active (Gate 1)** |
| B10 | Only the worker role writes the ledger | DB grants (migration 0016) + grant-matrix DB test (`packages/testing/src/__tests__/db/grants.db.test.ts`, CI) | **Active (Gate 2)** |
| B11 | Every HTTP handler declares a policy | `assertEndpointRegistry` (`@hsp/policy`) runs in each app composition (`apps/*/src/bootstrap.ts`), so a handler without a registered policy refuses to start; unknown actions are denied by default. Unit + DB tests | **Active (Gate 3)** |
| B12 | Every mutating endpoint declares idempotency | Same check: each `EndpointSpec` declares `required`, `implicit` or `none` with a stated reason | **Active (Gate 3)**. `required` endpoints are enforced with `beginIdempotent` / `completeIdempotent` (`@hsp/db`, `platform.idempotency_keys`); first user: `POST /admin/v1/grants` |

`__tests__/boundaries.test.ts` plants one violation per active rule in a throwaway tree and asserts each is reported.
