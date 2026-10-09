# Phase 2 · 02 — Repository Structure

> Status: **DRAFT for founder approval** · Date: 2026-10-08 · No code exists yet. This defines what Gate 1 creates.
> Namespace: brand-neutral `@hsp/*` ([ADR-021](../phase-1/15-architecture-decisions.md#adr-021-neutral-technical-identifiers)).

---

## 1. Tooling choices (exact versions pinned at Gate 1, each ≥ 2 weeks old, recorded in an ADR addendum)

| Concern | Choice | Why |
|---|---|---|
| Monorepo | **pnpm workspaces** + **Turborepo** | pnpm's strict `node_modules` blocks phantom dependencies (boundary safety). Turborepo task graph and caching. Simpler than Nx |
| Runtime | Node.js active LTS | ADR-014 |
| Language | TypeScript `strict` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Correctness |
| Backend framework | Decorator-free HTTP library compatible with Node type stripping (to be chosen before the first served endpoint) over framework-neutral handlers; NestJS rejected | ADR-024 #1 (amends ADR-014) |
| DB access / migrations | Drizzle (typed queries) + **hand-written forward-only SQL migrations** + `squawk` lint | Phase 1 03 §14.7 |
| Queue / timers | Graphile Worker | ADR-015 |
| Validation / contracts | Zod → OpenAPI 3.1 | Phase 1 04 |
| Web (PWA + agent web + BFF) | Next.js | ADR-003 |
| Admin web | React + Vite SPA, served only by `admin-api` behind the zero-trust proxy | ADR-013 |
| Technician app | React Native (Expo, Hermes), **pending the device spike (ADR-004 gate)** | ADR-004 |
| Tests | Vitest, Testcontainers, Playwright, Maestro, fast-check, k6 | Phase 1 13 |
| Boundaries | `dependency-cruiser` + ESLint `no-restricted-imports` + package `exports` maps + query-tag fitness test | Phase 1 01 §4.1 |
| Security tooling | gitleaks (pre-commit + CI), Semgrep, OSV-Scanner/Dependabot, Trivy, Checkov, ZAP (from Gate 8) | Phase 1 14 §4 |
| IaC | Terraform/OpenTofu | Phase 1 14 |

---

## 2. Top-level layout

```
/
├─ apps/                         # deployable entrypoints (thin: compose packages, no business logic)
│  ├─ web-bff/                   # Next.js: customer PWA + field-agent web + BFF routes (session cookie, signed client-IP)
│  ├─ admin-web/                 # React SPA for the admin console (static, served by admin-api only)   ← added; see §6
│  ├─ api/                       # HTTP:   /v1 customer, technician, agent surfaces
│  ├─ admin-api/                 # HTTP:   /admin/v1 (separate realm, zero-trust proxy)
│  ├─ webhook/                   # HTTP:   provider callbacks → verify, persist raw, ack, enqueue
│  ├─ voice/                     # HTTP:   IVR flow engine (internal only)
│  ├─ worker/                    # Graphile Worker runner: outbox relay, subscribers, ledger postings, file scanning dispatch
│  ├─ scheduler/                 # singleton: sweeper, cron jobs (retention, payout batch build, partitions)
│  ├─ media-scanner/             # isolated decoder/scan task (SR-09): minimal IAM, no DB role, no egress   ← added; see §6
│  └─ technician-app/            # Expo React Native (Android-first)
│
├─ packages/
│  ├─ kernel/                    # @hsp/kernel: ids (UUIDv7), clock, config schema loader, Result, context (actor, correlation)
│  ├─ money/                     # @hsp/money: Paise type, bps math, largest-remainder split, formatting (INR, Indian grouping)
│  ├─ errors/                    # @hsp/errors: domain error taxonomy, problem+json mapping (no internals leaked)
│  ├─ events/                    # @hsp/events: event envelope, schema registry, outbox writer, processed-events guard
│  ├─ policy/                    # @hsp/policy: authZ engine (can(actor, action, resource, ctx)), decision logging, matrix registry
│  ├─ observability/             # @hsp/observability: allowlist logger, OTel setup, metrics helpers, PII canary hooks
│  ├─ security/                  # @hsp/security: field crypto (envelope, key-subject registry), blind index, HMAC signing,
│  │                             #                OTP/code hashing, Argon2id wrapper, webhook signature verifiers
│  ├─ localization/              # @hsp/localization: locale registry, ICU catalogs (te-IN, en-IN), enablement gate checks
│  ├─ db/                        # @hsp/db: pools per process role, query tagging (/* module=… */), tx/unit-of-work, test DB utils
│  ├─ contracts/                 # @hsp/contracts: Zod request/response DTOs per surface (customer/technician/agent/admin/hooks)
│  ├─ design-tokens/             # @hsp/design-tokens: colours, type scale, spacing, radii, elevation (web + native)
│  ├─ ui-web/                    # @hsp/ui-web: web component library (PWA, agent web, admin variants)
│  ├─ ui-native/                 # @hsp/ui-native: RN component library (technician app)
│  ├─ testing/                   # @hsp/testing: factories, fixtures (synthetic Kurnool data), fakes, authZ-matrix generator,
│  │                             #               property-test arbitraries, canary-PII scanner, time-travel clock
│  │
│  ├─ modules/                   # bounded contexts (one Postgres schema each)
│  │  ├─ identity/  customers/  workforce/  verification/  catalog/  pricing/
│  │  ├─ jobs/  diagnosis/  matching/  voice/  comms/  payments/
│  │  ├─ warranty/  trust/  geo/  backoffice/  compliance/  ai/  files/  config/
│  │  └─ benefits/               # skeleton only (no money, flag off)
│  │
│  └─ adapters/                  # implementations of ports declared in module `public/ports`
│     ├─ telephony-simulator/    # Gate 10. Deterministic scripted provider for tests
│     ├─ telephony-<provider-a>/ # created only after Spike S-1 passes
│     ├─ sms-fake/  whatsapp-fake/  push-fake/
│     ├─ payments-sandbox-<pa>/  # PA sandbox adapter (test mode only)
│     ├─ maps-fake/  kyc-fake/  ai-fake/
│     └─ kms-local/              # local KMS emulation for dev/test
│
├─ db/
│  └─ migrations/                # forward-only SQL: NNNN_<module>__<description>.sql (module prefix = owning schema)
├─ infra/                        # Terraform: modules/ + envs/{dev,test,staging}. NO prod env in Phase 2
├─ tools/                        # architecture fitness checks, codegen (OpenAPI), seed loaders, grant-matrix checker
├─ docs/                         # phase docs, ADRs, runbooks
└─ .github/                      # workflows, CODEOWNERS, PR template (security checklist)
```

### 2.1 Module package layout (every `packages/modules/<name>`)

```
<name>/
├─ package.json          # "exports": { ".": "./src/public/index.ts", "./http": "./src/http/index.ts" }. Nothing else importable
└─ src/
   ├─ public/            # facade interface, DTOs, event types, ports (interfaces for adapters), error codes
   ├─ application/       # commands/queries, transaction boundaries, policy calls, outbox writes
   ├─ domain/            # aggregates, state machines (transition tables), invariants, pure functions
   ├─ infrastructure/    # repositories (own schema only), Drizzle table defs (NOT exported), adapters wiring
   ├─ http/              # controllers per surface (registered by apps), mapping DTO ↔ application
   └─ __tests__/         # unit + integration + module contract tests
```

---

## 3. Boundary rules (enforced in CI from Gate 1)

| # | Rule | Enforcement |
|---|---|---|
| B1 | A module imports other modules **only via their `public` entry**. Deep imports are impossible | `exports` maps + dependency-cruiser |
| B2 | **No module accesses another module's repositories or tables** | Drizzle table defs not exported. The query-tag fitness test asserts each SQL statement touches only the owning schema (+ `platform`) |
| B3 | Facade calls follow the allowed dependency graph (Phase 1 01 §4.3). No cycles | dependency-cruiser ruleset generated from the graph |
| B4 | Cross-module transactional calls are limited to **TCP-1, TCP-2, TCP-3** | Fitness test detecting nested unit-of-work joins outside the allowlist |
| B5 | Kernel packages (`kernel`, `money`, `errors`, `events`, `policy`, `observability`, `security`, `localization`, `db`) never import modules | dependency-cruiser |
| B6 | Apps contain wiring only: no domain logic, no SQL | Lint rule (no `@hsp/db` query APIs in `apps/*` except bootstrap) + review |
| B7 | **Frontends** (`web-bff` client bundles, `admin-web`, `technician-app`) may import only `@hsp/contracts` (client-safe subset), `design-tokens`, `ui-*`, `localization`, `money` formatting. Never modules, `security`, `db` or adapters | dependency-cruiser + bundle analyzer check for forbidden modules |
| B8 | **No secrets in frontends or source.** Only publishable keys, restricted by package/signature/referrer | gitleaks, a bundle secret scan, review checklist |
| B9 | Adapters depend on the module `public/ports` only. Modules never import adapters (DI wiring in apps) | dependency-cruiser |
| B10 | Ledger tables are writable only from code running in the `worker` app (G-5) | DB grants + a test that the `api`/`admin-api`/`voice` roles fail to INSERT into `ledger.*` |
| B11 | Every HTTP handler declares a policy. Default deny | Policy registry check at boot + CI |
| B12 | Every mutating endpoint declares idempotency behaviour | Contract metadata check |

---

## 4. Configuration & secrets
- Each app validates its environment with a Zod schema at boot and **refuses to start** on missing/invalid config.
- Deployed environments (`dev`, `test`, `staging`): secrets from AWS Secrets Manager via task-role injection. **No production environment or credentials exist in Phase 2.**
- Local: `.env.local` (git-ignored) generated by `tools/dev-env` with **fake values**. Local KMS emulation. Provider fakes.
- Startup assertions: `env != prod` ⇒ fixed-code OTP test numbers allowed. Real-provider adapters for telephony/PA/KYC **refuse to load** unless an explicit `allow_external_<provider>=true` flag is set **and** the environment is `staging`/`test` with sandbox credentials.

## 5. Branching, reviews, CODEOWNERS
- Trunk-based. Protected `main`. Signed commits. Required checks (Gate 1 list).
- CODEOWNERS: 2 reviewers for `packages/modules/{identity,backoffice,payments,pricing,compliance,voice}`, `packages/security`, `packages/policy`, `db/migrations`, `infra`, `.github`.
- PR template: security checklist (authZ declared, idempotency, PII in logs, new columns tagged, migrations reviewed, tests for invariants).

## 6. Additions to the founder's app list (for approval)
- **`apps/admin-web`:** the admin console UI needs a frontend home. It's built as static assets and served **only** by `admin-api` behind the zero-trust proxy. It isn't a separate deployable service.
- **`apps/media-scanner`:** the isolated decoder/scanner task required by SR-09 (minimal privileges, no egress, no DB role). Deployed as its own small ECS task.

Neither changes the architecture. Both implement already-approved decisions.
