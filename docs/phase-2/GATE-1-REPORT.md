# Gate 1 Review: Repository, CI/CD, security scanning, dev/test infrastructure

> Date: 2026-10-08 (updated 2026-10-09) · Decision: **PASS WITH CONDITIONS** (see §4) · GitHub CI G1–G6 **PASS** (§2a); G7 **partial** (interim ruleset, TE-03); G8–G9 pending · **AWS deployment deferred by founder decision (2026-10-09)**: all AWS proofs deferred under **TE-01**, and AWS doesn't block local/CI development · Gate 2 **started 2026-10-09 on the founder's go** under TE-02, a narrow solo-development exception amended 2026-10-09 ([GATE-2-REPORT](GATE-2-REPORT.md)). Its start condition was G1–G6 PASS and the G7 interim protections verified, with G8/G9 and AWS deferred ([closure checklist §0](GATE-1-CLOSURE-CHECKLIST.md#te-02-gate-2-may-start-before-gate-1-is-pass-narrow-solo-development-exception)).

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

## 2a. GitHub CI evidence (2026-10-08)
**[CI run 37822630219](https://github.com/homesvcplatform/platform/actions/runs/37822630219)** on `main`, commit `f24d451`. Every job succeeded. `supply-chain-selftest` was skipped by design because there are no AWS variables yet (A6, TE-01). Each line was read from the job logs:
| Proof | Result |
|---|---|
| G1 `verify` | **PASS**: frozen install, no-prod guard, workspace check, typecheck 53/53, 0 boundary violations, 92/92 tests |
| G2 `secrets-scan` | **PASS**: gitleaks full history (6 commits) no leaks; planted-secret self-test detected |
| G3 `sast` | **PASS**: Semgrep 1.180.0, 368 rules, 0 findings; planted-code self-test 3 findings |
| G4 `sca` | **PASS**: OSV-Scanner v2.6.0, 205 packages, no issues |
| G5 `iac` | **PASS**: `terraform fmt` and `validate` for all 4 roots (first binary validation of the Terraform); Checkov 3.3.26 496 passed / 0 failed / 43 justified skips; fixture self-test 14 failures |
| G6 `image` | **PASS**: build OK, Trivy v0.75.0 0 findings, CycloneDX SBOM uploaded. Not pushed or signed (A5 needs AWS) |
| G7 | **PARTIAL** (TE-03): interim ruleset `main-protection-interim` (id 24743658) active and verified by API read-back. **Live:** direct push to `main` rejected (GH013, PR required, 6 required checks); PR #3 merge blocked by "Commits must have verified signatures". Approval and code-owner rules deferred until there are more members |
| G8, G9 | **PENDING**: need real additional members and throwaway PRs ([closure checklist §3](GATE-1-CLOSURE-CHECKLIST.md#3-must-be-proven-in-github-ci-no-te-01-impact)) |

**How it got green.** The first run (37819790355, `6ea5830`) failed three jobs, all fixed at the root in `4971643` and `f24d451` without weakening any check:
- **`image` (Trivy):** the distroless `nodejs24-debian12` runtime ships OpenSSL 3.0.18 (CVE-2026-31789 critical, plus 5 high), and no patched build of that image exists.
  - The runtime base moved to `gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by digest, with `libssl3t64 3.5.7-1~deb13u3`, which Debian lists as fixed.
  - It is still a distroless, non-root Node 24 image (ADR-022 #6 unchanged in substance).
- **`sast` (Semgrep, 9 findings):** these came from new supply-chain rules in `p/default`.
  - Added a 7-day release-age gate: Dependabot `cooldown`, `.npmrc` `min-release-age`, pnpm `minimumReleaseAge`.
  - Added pnpm `trustPolicy: no-downgrade` and `blockExoticSubdeps: true`.
  - Added one justified `nosemgrep` for KMS rotation on the asymmetric JWT signing key. AWS can't auto-rotate SIGN_VERIFY keys; this mirrors the existing CKV_AWS_7 skip.
- **`iac` (Checkov, 35 failures):**
  - **Real tightening:** the deploy role's ECR reads moved from `"*"` to the shared repository, and `ecs:TagResource` to its own task definitions.
  - `github_repository` defaults to `homesvcplatform/platform` and is validated as an exact `owner/repo`, so the OIDC `sub` conditions are concrete.
  - The three Mumbai AZs are allowlisted.
  - Bucket sub-resources now reference `aws_s3_bucket.this[each.key]`, so the existing encryption, versioning, logging, public-access block and lifecycle settings are linked. 30 findings were linkage false positives.
  - A justified skip on the not-yet-attached app security group, to be removed at Gate 3.
- **Second run (37822219298, `4971643`):** only the Checkov self-test failed. It scanned 0 resources because the repo's `.checkov.yaml` (auto-loaded from the working directory) had `skip-path: .selftest`, which hid the planted fixture. That Gate 1 mistake meant the self-test could never have caught a broken Checkov. Removing the skip-path fixed it (`f24d451`).

## 3. Not run locally (no Docker/Terraform/scanners on the workstation)
gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy, Syft/cosign and `terraform fmt/validate` run in GitHub CI only, each with a **self-test that proves the control fires**. They have now run and passed in CI (§2a). cosign signing hasn't run yet: it needs AWS (A5).

## 4. Conditions to close Gate 1
| # | Condition | Owner |
|---|---|---|
| C1 | GitHub org/repo `homesvcplatform/platform` **done** (I-7). Pushed; **first CI run green: G1–G6 PASS** (§2a). Remaining: plan (I-3), the teams in CODEOWNERS, commit signing, run `tools/github/apply-repo-protection.sh`, then prove G7–G9 with throwaway PRs | Founder + tech lead |
| C2 | **Deferred (TE-01, founder decision 2026-10-09).** When AWS resumes: state bucket, `terraform apply` shared-services (`consumer_account_ids = []`) and `infra/org`, the repository variables from shared-services, and record A1a, A3, A5, A6, A8a. Then the dev/test accounts, re-apply shared-services with their real IDs, apply dev/test, set the environment variables | Founder / DevOps |
| C3 | **Deferred (TE-01); A1b, A2, A4, A7, A8b are also blocked by the account quota.** A manual `ecs:RegisterTaskDefinition` by a non-deploy role is denied (SCP, A4). Config rule shows no public buckets (A2). dev/test apply (A1b). The same signed digest deploys to dev **and** test from the shared registry (A7), and other dev principals can't pull (A8b). Commit `.terraform.lock.hcl` | DevOps |
| ~~C4~~ | ~~Decide I-6~~ **Resolved 2026-10-08:** the existing `hsp-region-allowlist` and `hsp-security-baseline` SCPs also attach to the Infrastructure OU (shared-services). No new policy text. Still to be proven in AWS (A3) | Founder |

## 4a. Architecture changes recorded in this gate
- **ADR-022** (Accepted by the founder 2026-10-08). I-1 fixed (Terraform >= 1.10.0). **I-2 Option A implemented** (ADR-022 #11): one shared registry `hsp-shared-backend` and CI build role `hsp-shared-ci-build` in `infra/envs/shared-services`. dev/test pull cross-account via explicit `shared_ecr_*` inputs, and the per-environment ECR repositories and `ecr` keys are removed. Exact change set: [closure checklist §5](GATE-1-CLOSURE-CHECKLIST.md#i-2-change-set-exactly-what-changed). **I-6 resolved:** the existing region and security-baseline SCPs also attach to the Infrastructure OU ([change set](GATE-1-CLOSURE-CHECKLIST.md#i-6-change-set-exactly-what-changed)). Dependency-inversion ports `MaterialUsageRecorder`/`BillIssuer` (TCP-2/TCP-3, owned by `jobs`) and `OtpSender` (owned by `identity`) keep the module graph acyclic without changing transaction semantics. Also records toolchain pins, Node type stripping, framework timing, the distroless image, keyless signing, X86_64 and naming.
- **Registry amendments** (2026-10-08, ADR-022 #11 amendment): the consumer-account list may be empty (no cross-account access) until dev/test exist, and an explicit repository-policy Deny means only `hsp-shared-ci-build` can push ([details](GATE-1-CLOSURE-CHECKLIST.md#registry-amendments-2026-10-08-founder-approved-with-the-te-01-decision)).
- **TE-03** (2026-10-08): with a single organisation member, an interim ruleset enforces everything that doesn't need a second person (PR + 6 required checks, signed and linear history, no force push or deletion, squash only). Approval and code-owner rules wait until there are at least 3 Write-access members. The final `main-protection.json` is unchanged ([closure checklist §0](GATE-1-CLOSURE-CHECKLIST.md#te-03-interim-ruleset-while-the-organisation-has-a-single-member)).
- **TE-02** (amended 2026-10-09): Gate 2 may start on local/CI infrastructure with synthetic data once G1–G6 are PASS and the G7 interim protections are verified. G8/G9 stay pending until real members join. Gate 2 stays PASS WITH CONDITIONS until the deferred managed-database verification. No Gate 3 work. The interim protections may not be weakened. The final ruleset, G8 and G9 are mandatory before TE-03 closes.
- **Temporary exceptions** (not architecture changes): **TE-01** (widened 2026-10-09) records **AWS as a deferred external deployment dependency**. All AWS proofs are deferred, the AWS Terraform stays in the repository as the intended target (validated and scanned in CI, not applied), and development uses the `local` and CI environments (PostgreSQL 17 + PostGIS, Valkey, MinIO, fake providers, synthetic data). No other cloud replaces AWS. The architecture is unchanged and no accounts are consolidated. **TE-02** allows Gate 2 to start, restricted, before Gate 1 is PASS ([closure checklist §0](GATE-1-CLOSURE-CHECKLIST.md#0-temporary-exceptions-founder-approved-2026-10-08)).
- Closure steps, proof separation (local / GitHub CI / AWS) and the issues found during closure prep (I-1…I-8): [GATE-1-CLOSURE-CHECKLIST.md](GATE-1-CLOSURE-CHECKLIST.md).

## 5. Security notes / threat-model delta
- New: dependency on public Sigstore (Fulcio/Rekor) for keyless signing (ADR-022 #7).
- New (I-2): image pulls cross an account boundary. Shared registry access is limited by repository and key policies to `hsp-*-task-execution`/`hsp-*-deploy` roles in the listed dev/test accounts (pull only). The shared-services account becomes supply-chain critical, and it now gets the region and security-baseline SCPs through the Infrastructure OU (I-6). Push is denied by an explicit repository-policy Deny to everyone except the CI build role, including same-account administrators (A8a).
- TE-01 risk: the Terraform stays unexercised in real AWS, and the registry-dependent supply-chain controls (push, keyless signing, attestation, signed deploy) stay unproven end to end. Gate 1 can't reach PASS while TE-01 is open, so proceeding to Gate 3 without AWS will need an explicit founder decision. TE-02 risk: Gate 2 DB work is proven on containers, not RDS, until the required RDS re-run.
- Valkey AUTH token passes through Terraform state (random_password). The state bucket must be KMS-encrypted with restricted access (backend example sets `encrypt = true`).
- Gate 1 logger is a conservative token-based denylist. The full allowlist + canary-PII scanning arrives at Gate 3.

## 6. Tech-debt register
- ESLint uses `tseslint.configs.strict` without type-aware rules (faster). Revisit at Gate 3.
- `media-scanner` shares the backend image until decoders are added (ADR-022 #6).
- Fargate X86_64 instead of Graviton (ADR-022 #8).
