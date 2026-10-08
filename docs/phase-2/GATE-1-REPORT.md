# Gate 1 Review: Repository, CI/CD, security scanning, dev/test infrastructure

> Date: 2026-10-08 · Decision: **PASS WITH CONDITIONS** (see §4) · AWS workload-account proofs deferred under temporary exception **TE-01**, not waived · Gate 2 **not started**. It may start only under **TE-02** once G1–G9 are recorded and the founder says so ([closure checklist §0](GATE-1-CLOSURE-CHECKLIST.md#0-temporary-exceptions-founder-approved-2026-10-08)).

## 1. Scope delivered vs planned ([03 §Gate 1](03-phase-2-gates.md#gate-1-repository-cicd-security-scanning))
| Planned | Delivered |
|---|---|
| Monorepo per 02 | pnpm 10.34.5 workspaces + Turborepo 2.11.3. 53 packages: 7 backend roles, 3 frontend placeholders, 14 shared, 21 modules (public + http entries only), 8 adapters |
| TypeScript strict | `tsconfig.base.json`: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, erasableSyntaxOnly, verbatimModuleSyntax |
| Boundary rules B1–B12 wired | B1, B3, B5–B9 active (dependency-cruiser generated from `tools/architecture/modules.json` + ESLint + exports maps + workspace check). B2/B4/B10/B11/B12 scheduled for Gates 2/3/5 (they need DB/HTTP). See `tools/architecture/README.md` |
| CI: lint, typecheck, unit, dependency-cruiser | `.github/workflows/ci.yml` job `verify` → `pnpm run ci` |
| gitleaks, Semgrep, OSV, Trivy, Checkov, SBOM, cosign | Jobs `secrets-scan` (+ planted-secret self-test), `sast` (+ planted-code self-test), `sca`, `iac` (+ insecure-fixture self-test), `image` (Trivy, CycloneDX SBOM, keyless cosign sign + SBOM attestation on main), `supply-chain-selftest` (unsigned image must be refused). Dependabot for npm, actions, docker, terraform |
| IaC for dev/test | `infra/modules/{kms,network,storage,data-stores,ecs-platform,ci-oidc,guardrails,secrets,registry,ci-build}`, `infra/envs/{shared-services,dev,test}`, `infra/org` (SCPs). The image registry and CI build role are in shared-services per Phase 1 14 §2.1 (I-2, ADR-022 #11) |
| Signed-image deploy path (SR-16) | `deploy.yml` (dev/test only) → `tools/deploy/verify-image.sh` (digest + signature + SBOM attestation, fail-closed) → `render-task-definition.mjs` (non-root, read-only FS, caps dropped, digest-pinned) + org SCP + EventBridge out-of-band-change alert |
| CODEOWNERS, PR template, protected main | `.github/CODEOWNERS`, `PULL_REQUEST_TEMPLATE.md` (security checklist), `.github/rulesets/main-protection.json` + `tools/github/apply-repo-protection.sh`, two-approvals check for sensitive paths |
| Secrets/config validation, no-production guardrails | `@hsp/kernel`: Zod env schema (no `prod` value), `assertNonProduction`, `assertExternalAdapterAllowed`, `ivrProductionStateChangesEnabled() === false`. Repo guard `check-no-prod.mjs`. Terraform `allowed_account_ids` + dev/test only. Deploy workflow dev/test only |

## 2. Evidence (run locally on 2026-10-08)
| Check | Result |
|---|---|
| `pnpm run ci` (guard:no-prod, guard:workspace, lint, typecheck, arch, test) | **All green**. 53/53 packages typecheck. 0 boundary violations (83 modules). **92/92 tests** |
| Planted violations in the real repo (B1, B3 ×2, B7) | `pnpm run arch` → **4 errors, exit 4**. ESLint also flags the relative deep import. Clean again after removal |
| Boundary self-test suite (13 cases incl. cycle + unresolvable) | Pass. No false positives on approved edges |
| Role boot | `api` starts (APP_ENV=local), `/healthz` → `{"status":"ok"}`, structured log line |
| No-production refusals | `APP_ENV=production` → GuardrailError. `PROD_DATABASE_URL` set → refused. Unknown AWS account → refused. Invalid config → ConfigError naming keys without values |
| Deploy controls | Non-digest image refs refused (exit 2). Unverifiable signature refused (exit 1, fail-closed). `prod`/`production` targets refused by the renderer |
| `pnpm audit` | No known vulnerabilities |
| Workflows | 3 workflows parse. **23/23 action references pinned to full commit SHAs**. Base images pinned by digest |
| Re-run after I-1/I-2, I-6 and the registry amendments (2026-10-08) | `pnpm run ci` all green again (53/53 typecheck, 0 boundary violations, 92/92 tests, no-prod guard passes with `infra/envs/shared-services`). Scripted Terraform cross-reference check of all four roots is clean. **Not** a substitute for `terraform validate`, which remains CI-only (G5) |

## 3. Not run locally (no Docker/Terraform/scanners on the workstation; GitHub CI and AWS proofs not yet recorded)
gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy, Syft/cosign, `terraform fmt/validate`. Each runs in CI with a **self-test that proves the control fires**. Terraform has not yet been validated by the binary.

## 4. Conditions to close Gate 1
| # | Condition | Owner |
|---|---|---|
| C1 | GitHub org/repo `homesvcplatform/platform` **done** (I-7). Create the teams in CODEOWNERS. Push. Run `tools/github/apply-repo-protection.sh`. **First CI run green**, including the gitleaks/Semgrep/Checkov self-tests and `terraform validate` | Founder + tech lead |
| C2 | AWS **now:** state bucket, `terraform apply` shared-services (`consumer_account_ids = []`) and `infra/org`, and the repository variables from shared-services. Record A1a, A3, A5, A6, A8a. **After TE-01:** dev/test accounts, re-apply shared-services with their real IDs, apply dev/test, and set the environment variables | Founder / DevOps |
| C3 | **Blocked by TE-01:** a manual `ecs:RegisterTaskDefinition` by a non-deploy role is denied (SCP, A4). Config rule shows no public buckets (A2). dev/test apply (A1b). The same signed digest deploys to dev **and** test from the shared registry (A7), and other dev principals can't pull (A8b). Commit `.terraform.lock.hcl` | DevOps |
| ~~C4~~ | ~~Decide I-6~~ **Resolved 2026-10-08:** the existing `hsp-region-allowlist` and `hsp-security-baseline` SCPs also attach to the Infrastructure OU (shared-services). No new policy text. Still to be proven in AWS (A3) | Founder |

## 4a. Architecture changes recorded in this gate
- **ADR-022** (Accepted by the founder 2026-10-08). I-1 fixed (Terraform >= 1.10.0). **I-2 Option A implemented** (ADR-022 #11): one shared registry `hsp-shared-backend` and CI build role `hsp-shared-ci-build` in `infra/envs/shared-services`. dev/test pull cross-account via explicit `shared_ecr_*` inputs, and the per-environment ECR repositories and `ecr` keys are removed. Exact change set: [closure checklist §5](GATE-1-CLOSURE-CHECKLIST.md#i-2-change-set-exactly-what-changed). **I-6 resolved:** the existing region and security-baseline SCPs also attach to the Infrastructure OU ([change set](GATE-1-CLOSURE-CHECKLIST.md#i-6-change-set-exactly-what-changed)). Dependency-inversion ports `MaterialUsageRecorder`/`BillIssuer` (TCP-2/TCP-3, owned by `jobs`) and `OtpSender` (owned by `identity`) keep the module graph acyclic without changing transaction semantics. Also records toolchain pins, Node type stripping, framework timing, the distroless image, keyless signing, X86_64 and naming.
- **Registry amendments** (2026-10-08, ADR-022 #11 amendment): the consumer-account list may be empty (no cross-account access) until dev/test exist, and an explicit repository-policy Deny means only `hsp-shared-ci-build` can push ([details](GATE-1-CLOSURE-CHECKLIST.md#registry-amendments-2026-10-08-founder-approved-with-the-te-01-decision)).
- **Temporary exceptions** (not architecture changes): **TE-01** defers the AWS workload-account proofs while the AWS Organizations account quota blocks creating dev/test. The architecture is unchanged and no accounts are consolidated. **TE-02** allows Gate 2 to start, restricted, before Gate 1 is PASS ([closure checklist §0](GATE-1-CLOSURE-CHECKLIST.md#0-temporary-exceptions-founder-approved-2026-10-08)).
- Closure steps, proof separation (local / GitHub CI / AWS) and the issues found during closure prep (I-1…I-8): [GATE-1-CLOSURE-CHECKLIST.md](GATE-1-CLOSURE-CHECKLIST.md).

## 5. Security notes / threat-model delta
- New: dependency on public Sigstore (Fulcio/Rekor) for keyless signing (ADR-022 #7).
- New (I-2): image pulls cross an account boundary. Shared registry access is limited by repository and key policies to `hsp-*-task-execution`/`hsp-*-deploy` roles in the listed dev/test accounts (pull only). The shared-services account becomes supply-chain critical, and it now gets the region and security-baseline SCPs through the Infrastructure OU (I-6). Push is denied by an explicit repository-policy Deny to everyone except the CI build role, including same-account administrators (A8a).
- TE-01 risk: the dev/test Terraform stays unexercised in AWS longer. TE-02 risk: Gate 2 DB work is proven on containers, not RDS, until the required RDS re-run.
- Valkey AUTH token passes through Terraform state (random_password). The state bucket must be KMS-encrypted with restricted access (backend example sets `encrypt = true`).
- Gate 1 logger is a conservative token-based denylist. The full allowlist + canary-PII scanning arrives at Gate 3.

## 6. Tech-debt register
- ESLint uses `tseslint.configs.strict` without type-aware rules (faster). Revisit at Gate 3.
- `media-scanner` shares the backend image until decoders are added (ADR-022 #6).
- Fargate X86_64 instead of Graviton (ADR-022 #8).
