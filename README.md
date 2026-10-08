# homesvcplatform (working codename: Housefi)

Home-services marketplace for Tier-2/3 India: phone-agnostic technician workforce, diagnosis-first repairs, trust and safety by design.
Technical namespace is brand-neutral (`@hsp/*`, `in.homesvcplatform.*`, ADR-021). The brand is configuration.

**Status:** Phase 2 · **Gate 1 (repository, CI/CD, security scanning, dev/test infrastructure)**. No business features yet.
Design docs: [`docs/`](docs/) (Phase 0 → 1 → 1.1 → 2). Gate plan: [`docs/phase-2/03-phase-2-gates.md`](docs/phase-2/03-phase-2-gates.md).

## Layout
```
apps/        process roles (thin entrypoints): api, admin-api, webhook, voice, worker, scheduler, media-scanner,
             web-bff, admin-web, technician-app (frontends: framework added in their gate)
packages/    shared kernel packages (@hsp/kernel, money, errors, events, policy, observability, security, ...)
packages/modules/   21 bounded modules (@hsp/module-*): only src/public (+ src/http for apps) is importable
packages/adapters/  fakes/sandboxes implementing module ports
infra/       Terraform: modules/, envs/{shared-services,dev,test} (no production), org/ (SCP guardrails)
tools/       architecture + guardrail checks, deploy verification
```

## Prerequisites
Node 24 LTS (`.nvmrc`) and pnpm via Corepack (`corepack enable pnpm`, version pinned in `package.json`).

## Everyday commands
| Command | What it checks |
|---|---|
| `pnpm install --frozen-lockfile` | Exact, reproducible install. Dependency lifecycle scripts are blocked |
| `pnpm run ci` | Everything below, in CI order |
| `pnpm run guard:no-prod` | No production environment is defined anywhere (Phase 2 rule) |
| `pnpm run guard:workspace` | Packages match `tools/architecture/modules.json`, exports locked, versions pinned |
| `pnpm run lint` | ESLint (strict TS, banned APIs, deep-import bans) |
| `pnpm run typecheck` | `tsc` strict across all 53 packages (Turborepo) |
| `pnpm run arch` | dependency-cruiser boundary rules B1, B3, B5–B9 |
| `pnpm run test` | Vitest, incl. boundary/guardrail/deploy-control self-tests |

Run a role locally (synthetic, no external services): `APP_ENV=local APP_ROLE=api PORT=8080 node apps/api/src/main.ts`, then `GET /healthz`.

## Non-negotiables (Phase 2)
No secrets in git · no production credentials or environment · no real customer PII · no real payments, telephony or KYC ·
no public buckets · all state changes server-authorised · all critical mutations idempotent · every authZ rule and invariant tested.
