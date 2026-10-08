# Gate 1 Closure Checklist

> **Gate 1 status: PASS WITH CONDITIONS**, unchanged until every external proof in §3 and §4 is recorded.
> Gate 2: **not started, untouched.** No scanner (gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy) is claimed to pass until it has run in GitHub CI.
> Prepared 2026-10-08. Updated 2026-10-08 after the founder's decisions (ADR-022 accepted, I-1 fixed, I-2 Option A implemented, I-6 resolved). Companion to [GATE-1-REPORT.md](GATE-1-REPORT.md).

---

## 1. Architecture changes recorded in this gate: ADR-022
Gate 1's structural changes are recorded in [ADR-022](../phase-1/15-architecture-decisions.md#adr-022-gate-1-foundation-decisions-phase-2-implementation-addendum) and must stay explicit in the gate review:
- **Dependency-inversion ports for TCP-2 and TCP-3.** `jobs/public` declares `MaterialUsageRecorder` and `BillIssuer`. `diagnosis` and `payments` implement them, and apps wire them. Without this, calls from `jobs` → `diagnosis` and `jobs` → `payments` create import cycles (`diagnosis` → `jobs`, `payments` → `diagnosis` → `jobs`). Transaction semantics are unchanged. `payments` gains a compile-time dependency on `jobs` (recorded in `tools/architecture/modules.json`).
- **`OtpSender` port** owned by `identity`, implemented by `comms`. This removes an `identity` ↔ `comms` cycle present in the Phase 1 text.
- **Shared-services registry (ADR-022 #11, I-2 Option A).** The ECR repository and the CI build role move from each workload account to the shared-services account, as Phase 1 14 §2.1 specifies. See §5 for exactly what changed.
- Other ADR-022 items (toolchain pins, Node type stripping, framework timing, distroless image, keyless signing, X86_64, naming, web-bff treated as frontend) are implementation choices under approved decisions.
- **ADR-022 ACCEPTED by the founder on 2026-10-08** (status updated in docs/phase-1/15). Item #11 was added afterwards under the founder's I-2 Option A approval.

---

## 2. Already proven locally (`pnpm run ci` and the Terraform cross-reference check re-run 2026-10-08 after the I-1/I-2 and I-6 changes; other rows are from the original Gate 1 run, and no application code has changed since)
| Proof | Evidence |
|---|---|
| `pnpm run ci` passes | no-prod guard ✔ · workspace check ✔ · ESLint ✔ · strict typecheck **53/53** ✔ · dependency-cruiser **0 violations** (83 modules) ✔ · Vitest **92/92** ✔ |
| Boundary violations fail | Planted B1/B3/B7 violations in the real repo → `pnpm run arch` exit 4 with 4 errors. 13-case self-test suite detects every active rule + cycles + unresolvable imports, with no false positives |
| No-production guardrails | `APP_ENV=production`, `PROD_*` variables, and non-allowlisted AWS accounts are refused at boot. `prod` isn't a valid config value. Repo guard finds no prod environment (including the new `infra/envs/shared-services`) |
| Config validation | Invalid config refused. Error names keys but never values |
| Role boot | `api` starts locally and serves `/healthz` |
| Deploy controls (offline part) | Non-digest image refs refused. Unverifiable signature → refused (fail-closed). `prod`/`production` targets refused by the task-definition renderer. Rendered task definition is non-root, has a read-only root FS, drops all capabilities, and is digest-pinned |
| Dependencies | `pnpm audit`: no known vulnerabilities (npm advisory DB, **not** OSV-Scanner) |
| CI definitions | All 3 workflows + Dependabot + Semgrep/Checkov configs parse. 23/23 action references are SHA-pinned. Base images pinned by digest |
| Terraform cross-references (scripted, **not** `terraform validate`) | For `envs/shared-services`, `envs/dev`, `envs/test` and `org`: every module argument is a declared variable, every required variable is passed, every `module.*.*` output and `var.*` reference exists, brackets balance. No module still uses the removed `ecr` key |

**Not proven locally:** Docker build, gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy, Syft, cosign, and **`terraform fmt/validate/plan/apply`**. These tools aren't installed on this machine and none were installed. Terraform formatting and validation of the I-1/I-2 changes is **CI-only** (proof G5).

---

## 3. Must be proven in GitHub CI
| # | Proof | Pass criterion |
|---|---|---|
| G1 | `verify` job | Green on a clean runner (frozen lockfile install, full `pnpm run ci`) |
| G2 | `secrets-scan` | gitleaks over full history finds nothing **and** the planted-secret self-test step reports "Planted secret detected as expected" |
| G3 | `sast` | Semgrep (registry default + project rules) finds nothing blocking **and** the planted-code self-test flags the insecure file |
| G4 | `sca` | OSV-Scanner reports no known vulnerabilities in `pnpm-lock.yaml` |
| G5 | `iac` | `terraform fmt -check` and `validate` pass for `envs/shared-services`, `envs/dev`, `envs/test`, `org` (first time any Terraform binary checks the I-1/I-2/I-6 changes). Checkov passes on `infra/`, including the new `registry` and `ci-build` modules, **and** the insecure-fixture self-test reports failed checks |
| G6 | `image` | Docker build succeeds. Trivy finds no fixable HIGH/CRITICAL issues. CycloneDX SBOM artifact uploaded |
| G7 | Ruleset enforcement | Direct push to `main` rejected. A PR can't merge with any required check red. An unsigned commit is rejected |
| G8 | Boundary check blocks a PR | A throwaway PR that adds a deep cross-module import → `verify` red (then close the PR) |
| G9 | Two-approval rule | A throwaway PR touching `infra/` with one approval → `two-reviewers-for-sensitive-paths` red. With two approvals → green |

Record each as a link to the CI run in GATE-1-REPORT §2. Any scanner finding is fixed or explicitly risk-accepted before closure.

## 4. Must be proven in AWS
| # | Proof | Pass criterion |
|---|---|---|
| A1 | Infrastructure applies | `terraform apply` succeeds for **shared-services, then dev and test**. No public subnets in use, no public RDS/Valkey, data subnets have no internet route. dev/test contain **no** ECR repository |
| A2 | No public buckets | Attempt to set a public bucket policy/ACL in dev → denied (account-level block). AWS Config rules `s3-public-access-prohibited` and `s3-account-public-access` show COMPLIANT |
| A3 | Org guardrails | Applied from the management account. All three `infra/org` SCPs are attached to the **Workloads OU**. `hsp-region-allowlist` and `hsp-security-baseline` are attached to the **Infrastructure OU** (I-6). In shared-services, a regional call outside ap-south-1/ap-south-2 (e.g., `aws ecr describe-repositories --region us-east-1`) → **AccessDenied (explicit deny in SCP)** |
| A4 | Only the pipeline can deploy | From a non-deploy principal (e.g., your SSO admin role in dev), `aws ecs register-task-definition …` → **AccessDenied (explicit deny in SCP)**. The `ecs-out-of-band-change` alert fires to the SNS topic |
| A5 | Signed image published | A push to `main` → `image` job (CI build role in **shared-services**) pushes to `hsp-shared-backend`, keyless-signs and attaches the SBOM attestation (digest shown in the job summary) |
| A6 | Unsigned image refused | The `supply-chain-selftest` job is green ("Unsigned image refused as expected") |
| A7 | Signed deploy path works, cross-account | `Deploy` workflow to **`dev` and then `test`** with the same signed digest → verification of the shared-registry image passes in each and 7 task definitions are registered in each |
| A8 | Shared registry is least-privilege | From a dev principal that is neither `hsp-*-task-execution` nor `hsp-*-deploy` (e.g., your SSO admin role), `aws ecr batch-get-image` on `hsp-shared-backend` → **AccessDenied**. A push from any principal other than `hsp-shared-ci-build` → **AccessDenied** |

---

## 5. Issues found while preparing this checklist
| # | Issue | Status |
|---|---|---|
| I-1 | `infra/envs/*` and `infra/org` declared `required_version >= 1.9.0`, but `backend.hcl.example` uses `use_lockfile = true` (S3-native state locking needs Terraform ≥ 1.10) | **FIXED 2026-10-08 (founder-approved).** Now `required_version = ">= 1.10.0"` in `infra/envs/{dev,test}`, `infra/org` and the new `infra/envs/shared-services` |
| I-2 | **Deviation from Phase 1 14 §2.1:** Gate 1 placed the ECR repository and CI build role **in each workload account**, but Phase 1 places them in a **shared-services account**. CI pushes to one registry, so `deploy.yml` to **test** would have looked for the image in test's own ECR, where it doesn't exist | **IMPLEMENTED 2026-10-08 (founder-approved Option A, ADR-022 #11).** Details below. Unproven until G5 and A1, A5, A7, A8 |
| I-3 | Rulesets on **private** repos need a paid GitHub plan (Team or higher). Secret-scanning push protection on private repos needs GitHub Secret Protection (paid) | **Open, founder action** (§6.1). Without them, G7 can't be proven and `apply-repo-protection.sh` partially fails. gitleaks in CI covers secret detection either way |
| I-4 | AWS Config rules (guardrails module) need an AWS Config recorder in each workload account | **Open, founder action** (§6.3). Enable AWS Config (or Control Tower) first, or apply once with `enable_config_rules = false` and accept that A2's Config evidence is missing. Not needed in shared-services (no guardrails module there) |
| I-5 | `tools/deploy/verify-image.sh` was staged early to keep its executable bit | **Resolved.** Committed in the initial commit `6a9a529` |
| I-6 | **Shared-services had no SCP treatment in code.** `infra/org` attached the SCPs to the Workloads OU only. Phase 1 14 §2.1 draws SCPs at the organisation Root | **RESOLVED 2026-10-08 (founder decision: option a).** The existing `hsp-region-allowlist` and `hsp-security-baseline` SCPs are now also attached to the Infrastructure OU. No new policy text. Change set below. Unproven until G5 and A3. The account-level guardrails module (S3 account public-access block, EBS default encryption, Config rules, ECS drift alert) is still applied only in dev/test. That is unchanged and outside this decision |

### I-6 change set (exactly what changed)
- **`infra/org/main.tf`:**
  - New required variable `infrastructure_ou_id`, the OU holding the shared-services account.
  - New resource `aws_organizations_policy_attachment.infrastructure`. It attaches the **existing** `hsp-region-allowlist` and `hsp-security-baseline` policies (the same `aws_organizations_policy.scp` resources) to that OU.
  - Header comment updated.
- **Not attached to the Infrastructure OU:** `hsp-deploy-path-only`, because no ECS workloads run in shared-services.
- **Unchanged:** the policy text of all three SCPs and the Workloads OU attachments.
- **Effect on shared-services:**
  - Regional actions outside ap-south-1/ap-south-2 are denied (global services are excepted, as in Workloads).
  - Security services can't be disabled, and the account can't leave the organisation.
  - IAM users and access keys can't be created. The CI build role uses OIDC, so this doesn't affect it.
  - The account public-access block can't be changed except by `OrganizationAccountAccessRole`. Shared-services Terraform doesn't set it.
  - IMDSv2 is required, and the root user is denied.

### I-2 change set (exactly what changed)
- **Added `infra/modules/registry`:** the shared ECR repository `hsp-shared-backend` (immutable tags, scan on push, the same lifecycle rules as before) with its own KMS key (rotation on, 30-day deletion window, alias `alias/hsp-shared-ecr`).
  - The repository policy allows **pull only**, and only to principals in the listed dev/test accounts whose ARN matches `role/hsp-*-task-execution` or `role/hsp-*-deploy`.
  - The key policy allows `kms:Decrypt` to the same principals.
  - Push stays with the CI build role in the same account.
- **Added `infra/modules/ci-build`:** the GitHub OIDC provider and the CI build role `hsp-shared-ci-build`, moved unchanged from `ci-oidc`. It trusts only `repo:<owner/repo>:ref:refs/heads/main` and can push only to the shared repository and use only the shared key.
- **Added `infra/envs/shared-services`:** `main.tf` plus `backend.hcl.example` and `terraform.tfvars.example`.
  - The provider is pinned to the shared-services account and ap-south-1, with Terraform ≥ 1.10.0.
  - Output `github_variables` gives `AWS_CI_ROLE_ARN` and `ECR_REPOSITORY_URI`.
  - Output `workload_inputs` gives the `shared_ecr_*` values for dev/test.
- **`infra/modules/ci-oidc`:** the build role, its trust and permission policies, the `ecr_repository_arn` variable and the `ci_build_role_arn` output are removed. The per-environment deploy role is unchanged. It now decrypts with the shared key, passed in as an input.
- **`infra/modules/ecs-platform`:** the local ECR repository, its lifecycle policy and the `ecr_repository_arn`/`ecr_repository_url` outputs are removed. The task-execution role now pulls from the shared repository via the new `ecr_repository_arn` input.
- **`infra/modules/kms`:** the per-environment `ecr` data-class key is removed.
- **`infra/envs/dev` and `infra/envs/test`:**
  - New required inputs `shared_ecr_repository_arn`, `shared_ecr_repository_url` and `shared_ecr_kms_key_arn`. Each is validated to be the `hsp-shared-backend` repository, or a KMS key, in ap-south-1.
  - Their `github_variables` output no longer contains `AWS_CI_ROLE_ARN`.
  - Their `ECR_REPOSITORY_URI` is the shared URL.
  - Updated `terraform.tfvars.example`.
- **`.github/workflows/ci.yml`:** the `iac` job also runs `terraform validate` for `infra/envs/shared-services`. No other workflow change was needed. `image` and `supply-chain-selftest` already use the repository variables `AWS_CI_ROLE_ARN`/`ECR_REPOSITORY_URI`, which now point to shared-services. `deploy.yml` already uses the per-environment `AWS_DEPLOY_ROLE_ARN`/`ECR_REPOSITORY_URI`.
- **Docs:** ADR-022 #11 added, README layout line updated, and this checklist and GATE-1-REPORT updated.
- **Unchanged by I-2:** `infra/org` (changed separately for I-6), the guardrails, network, storage, data-stores and secrets modules, `deploy.yml`, `verify-image.sh`, `render-task-definition.mjs`, all application code, and Gate 2 scope.
- Nothing had been applied, so no state migration (`moved` blocks) is needed.

---

## 6. Founder setup checklist

### 6.1 GitHub repository and teams
- [ ] Choose the GitHub plan (see I-3). Create organisation **`homesvcplatform`** and private repository **`homesvcplatform/platform`** (the name used in Terraform examples. If different, update `github_repository` in every tfvars).
- [ ] Create teams with **Write** access (CODEOWNERS requires it): `engineering`, `platform-leads`, `security`, `payments`, `voice`. **At least 2 humans** must be able to approve sensitive paths.
- [ ] Every contributor sets up **commit signing** (SSH or GPG) before the ruleset is applied.
- [ ] Settings → Actions → General: "Read repository contents" default workflow permissions. Don't allow Actions to approve PRs.
- [ ] Settings → Code security: enable Dependabot alerts (and secret scanning/push protection if the plan allows).

### 6.2 Branch / ruleset protection (after the first push)
- [ ] Commit (signed) and push the current tree to `main`.
- [ ] Run once (repo admin, `gh` CLI authenticated): `tools/github/apply-repo-protection.sh homesvcplatform/platform`
  - creates ruleset `main-protection`: PR required, code-owner review, signed commits, linear history, no force-push/deletion, required checks `verify`, `secrets-scan`, `sast`, `sca`, `iac`, `image`, `two-reviewers-for-sensitive-paths`
  - creates environments `dev`, `test` (deploys from protected branches only)
- [ ] Add **required reviewers** to environments `dev` and `test`.

### 6.3 AWS accounts (non-production only)
- [ ] AWS Organizations with OUs: Security, **Infrastructure** (the **shared-services** account, required by I-2), **Workloads** (dev, test).
- [ ] shared-services, dev and test accounts in region **ap-south-1**. AWS IAM Identity Center for human access (no IAM users/access keys).
- [ ] AWS Config recorder (or Control Tower) in dev and test (I-4). CloudTrail organisation trail.
- [ ] Note the 12-digit account IDs (shared-services, dev, test, management), the **Workloads OU ID** and the **Infrastructure OU ID** (both required by `infra/org`).

### 6.4 Terraform state buckets and apply order (Terraform ≥ 1.10)
- [ ] One state bucket per account, created before `terraform init`, in ap-south-1: `hsp-shared-terraform-state` (shared-services), `hsp-dev-terraform-state` (dev), `hsp-test-terraform-state` (test). Each must have **Block Public Access on**, **versioning on**, **SSE-KMS** default encryption, a bucket policy denying non-TLS access, and access limited to the admin/IaC role.
- [ ] For each of `infra/envs/{shared-services,dev,test}`: copy `backend.hcl.example` → `backend.hcl` and `terraform.tfvars.example` → `terraform.tfvars`. Both are git-ignored.
- [ ] **1. shared-services first:** set `account_id`, `github_repository` and `consumer_account_ids = ["<dev id>", "<test id>"]`. Run `terraform -chdir=infra/envs/shared-services init -backend-config=backend.hcl` → `plan` → `apply`.
- [ ] **2. dev, then test:** copy `terraform output workload_inputs` from shared-services into each `terraform.tfvars` (`shared_ecr_repository_arn`, `shared_ecr_repository_url`, `shared_ecr_kms_key_arn`), plus `account_id` and `github_repository`. Then `init -backend-config=backend.hcl` → `plan` → `apply`.
- [ ] **3. org:** from the management account, `infra/org` (`management_account_id`, `workloads_ou_id`, `infrastructure_ou_id`). Apply SCPs after the accounts' baseline applies: the security-baseline SCP denies `s3:PutAccountPublicAccessBlock` to anyone except `OrganizationAccountAccessRole`.

### 6.5 GitHub OIDC variables (no secrets are needed: OIDC replaces AWS keys)
| Scope | Variable | Value from |
|---|---|---|
| Repository variable | `AWS_CI_ROLE_ARN` | **shared-services** output `github_variables.AWS_CI_ROLE_ARN` |
| Repository variable | `ECR_REPOSITORY_URI` | **shared-services** output `github_variables.ECR_REPOSITORY_URI` |
| Environment `dev` variables | `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URI`, `AWS_ACCOUNT_ID`, `TASK_EXECUTION_ROLE_ARN` | dev output `github_variables` (its `ECR_REPOSITORY_URI` equals the shared one) |
| Environment `test` variables | same four | test output `github_variables` |
| Secrets | **none** | Never add AWS access keys to GitHub |

---

## 7. Exact actions to close Gate 1
1. ~~Decide I-2 and I-1.~~ **Done:** I-1 fixed and I-2 Option A implemented (2026-10-08). Review and commit the I-1/I-2/I-6 changes (signed, once signing is set up).
2. ~~Accept ADR-022.~~ **Done** (2026-10-08). Item #11 records I-2.
3. ~~Decide **I-6**.~~ **Done** (2026-10-08): the existing region and security-baseline SCPs now also attach to the Infrastructure OU.
4. Complete **§6.1–6.2**: GitHub plan, org, repo, teams, signing, first signed push, `apply-repo-protection.sh`, environment reviewers.
5. Confirm the first CI run is green and record proofs **G1–G9** (run links) in GATE-1-REPORT §2. G5 is the first Terraform `fmt`/`validate` of the I-1/I-2/I-6 changes. Fix or formally risk-accept any scanner finding.
6. Complete **§6.3–6.5**: AWS accounts (including shared-services), Config, state buckets, Workloads and Infrastructure OU IDs, `terraform apply` in order shared-services → dev → test → org, GitHub variables.
7. Push to `main` and run the Deploy workflow to `dev` and `test`. Record proofs **A1–A8**.
8. When G1–G9 and A1–A8 are all recorded: change the Gate 1 decision from **PASS WITH CONDITIONS** to **PASS**, sign the gate review, and then (separately) approve the start of Gate 2.
