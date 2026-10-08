# Gate 1 Closure Checklist

> **Gate 1 status: PASS WITH CONDITIONS**, unchanged until every external proof in §3 and §4 is recorded.
> Gate 2: **not started, untouched.** No scanner (gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy) is claimed to pass until it has run in GitHub CI.
> Prepared 2026-10-08. Companion to [GATE-1-REPORT.md](GATE-1-REPORT.md).

---

## 1. Architecture change recorded in this gate: ADR-022
Gate 1 introduced one structural change. It is recorded in [ADR-022](../phase-1/15-architecture-decisions.md#adr-022-gate-1-foundation-decisions-phase-2-implementation-addendum) and must stay explicit in the gate review:
- **Dependency-inversion ports for TCP-2 and TCP-3.** `jobs/public` declares `MaterialUsageRecorder` and `BillIssuer`. `diagnosis` and `payments` implement them, and apps wire them. Without this, calls from `jobs` → `diagnosis` and `jobs` → `payments` create import cycles (`diagnosis` → `jobs`, `payments` → `diagnosis` → `jobs`). Transaction semantics are unchanged. `payments` gains a compile-time dependency on `jobs` (recorded in `tools/architecture/modules.json`).
- **`OtpSender` port** owned by `identity`, implemented by `comms`. This removes an `identity` ↔ `comms` cycle present in the Phase 1 text.
- Other ADR-022 items (toolchain pins, Node type stripping, framework timing, distroless image, keyless signing, X86_64, naming, web-bff treated as frontend) are implementation choices under approved decisions.
- **Founder action:** accept ADR-022 (status "Proposed" → "Accepted") as part of closure.

---

## 2. Already proven locally (re-run 2026-10-08, no code changes since)
| Proof | Evidence |
|---|---|
| `pnpm run ci` passes | no-prod guard ✔ · workspace check ✔ · ESLint ✔ · strict typecheck **53/53** ✔ · dependency-cruiser **0 violations** (83 modules) ✔ · Vitest **92/92** ✔ |
| Boundary violations fail | Planted B1/B3/B7 violations in the real repo → `pnpm run arch` exit 4 with 4 errors. 13-case self-test suite detects every active rule + cycles + unresolvable imports, with no false positives |
| No-production guardrails | `APP_ENV=production`, `PROD_*` variables, and non-allowlisted AWS accounts are refused at boot. `prod` isn't a valid config value. Repo guard finds no prod environment |
| Config validation | Invalid config refused. Error names keys but never values |
| Role boot | `api` starts locally and serves `/healthz` |
| Deploy controls (offline part) | Non-digest image refs refused. Unverifiable signature → refused (fail-closed). `prod`/`production` targets refused by the task-definition renderer. Rendered task definition is non-root, has a read-only root FS, drops all capabilities, and is digest-pinned |
| Dependencies | `pnpm audit`: no known vulnerabilities (npm advisory DB, **not** OSV-Scanner) |
| CI definitions | All 3 workflows + Dependabot + Semgrep/Checkov configs parse. 23/23 action references are SHA-pinned. Base images pinned by digest |

**Not proven locally:** Docker build, gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy, Syft, cosign, `terraform fmt/validate/plan/apply`. These tools aren't installed on this machine and none were installed.

---

## 3. Must be proven in GitHub CI
| # | Proof | Pass criterion |
|---|---|---|
| G1 | `verify` job | Green on a clean runner (frozen lockfile install, full `pnpm run ci`) |
| G2 | `secrets-scan` | gitleaks over full history finds nothing **and** the planted-secret self-test step reports "Planted secret detected as expected" |
| G3 | `sast` | Semgrep (registry default + project rules) finds nothing blocking **and** the planted-code self-test flags the insecure file |
| G4 | `sca` | OSV-Scanner reports no known vulnerabilities in `pnpm-lock.yaml` |
| G5 | `iac` | `terraform fmt -check` and `validate` pass for `envs/dev`, `envs/test`, `org`. Checkov passes on `infra/` **and** the insecure-fixture self-test reports failed checks |
| G6 | `image` | Docker build succeeds. Trivy finds no fixable HIGH/CRITICAL issues. CycloneDX SBOM artifact uploaded |
| G7 | Ruleset enforcement | Direct push to `main` rejected. A PR can't merge with any required check red. An unsigned commit is rejected |
| G8 | Boundary check blocks a PR | A throwaway PR that adds a deep cross-module import → `verify` red (then close the PR) |
| G9 | Two-approval rule | A throwaway PR touching `infra/` with one approval → `two-reviewers-for-sensitive-paths` red. With two approvals → green |

Record each as a link to the CI run in GATE-1-REPORT §2. Any scanner finding is fixed or explicitly risk-accepted before closure.

## 4. Must be proven in AWS
| # | Proof | Pass criterion |
|---|---|---|
| A1 | Infrastructure applies | `terraform apply` succeeds for dev (and test). No public subnets in use, no public RDS/Valkey, data subnets have no internet route |
| A2 | No public buckets | Attempt to set a public bucket policy/ACL in dev → denied (account-level block). AWS Config rules `s3-public-access-prohibited` and `s3-account-public-access` show COMPLIANT |
| A3 | Org guardrails | `infra/org` SCPs attached to the Workloads OU (applied from the management account) |
| A4 | Only the pipeline can deploy | From a non-deploy principal (e.g., your SSO admin role in dev), `aws ecs register-task-definition …` → **AccessDenied (explicit deny in SCP)**. The `ecs-out-of-band-change` alert fires to the SNS topic |
| A5 | Signed image published | A push to `main` → `image` job pushes, keyless-signs and attaches the SBOM attestation in ECR (digest shown in the job summary) |
| A6 | Unsigned image refused | The `supply-chain-selftest` job is green ("Unsigned image refused as expected") |
| A7 | Signed deploy path works | `Deploy` workflow to `dev` with the signed digest → verification passes and 7 task definitions are registered |

---

## 5. Issues found while preparing this checklist (reported, **not changed**)
| # | Issue | Impact | Recommended resolution (needs your approval) |
|---|---|---|---|
| I-1 | `infra/envs/*` and `infra/org` declare `required_version >= 1.9.0`, but `backend.hcl.example` uses `use_lockfile = true` (S3-native state locking needs Terraform ≥ 1.10) | Older Terraform versions would fail at `init`. CI uses 1.16.5, so CI is unaffected | One-line fix: `required_version = ">= 1.10.0"` in the three files |
| I-2 | **Deviation from Phase 1 14 §2.1:** Gate 1 places the ECR repository and CI build role **in each workload account**, but Phase 1 places them in a **shared-services account**. CI pushes to one registry (repo-level `ECR_REPOSITORY_URI`), so `deploy.yml` to **test** would look for the image in test's ECR, where it doesn't exist | Real blocker for the **test** deploy path only. Dev proofs (A5–A7) work | **Option A (recommended):** align with Phase 1. Move ECR + CI build role to a shared-services account with cross-account pull for dev/test (small infra change, before `terraform apply`). **Option B:** keep per-account ECR, prove A5–A7 in dev only, and fix before Gate 3 |
| I-3 | Rulesets on **private** repos need a paid GitHub plan (Team or higher). Secret-scanning push protection on private repos needs GitHub Secret Protection (paid) | Without them, G7 can't be proven and `apply-repo-protection.sh` partially fails | Choose the GitHub plan before creating the repo. gitleaks in CI covers secret detection either way |
| I-4 | AWS Config rules (guardrails module) need an AWS Config recorder in each account | `terraform apply` fails if no recorder exists | Enable AWS Config (or Control Tower) first, or apply once with `enable_config_rules = false` and accept that A2's Config evidence is missing |
| I-5 | `tools/deploy/verify-image.sh` is staged in the git index (side effect of setting its executable bit). Nothing else is staged or committed | None | Keep it. It preserves the executable bit in the first commit |

---

## 6. Founder setup checklist

### 6.1 GitHub repository and teams
- [ ] Choose the GitHub plan (see I-3). Create organisation **`homesvcplatform`** and private repository **`homesvcplatform/platform`** (the name used in Terraform examples. If different, update `github_repository` in tfvars).
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
- [ ] AWS Organizations with OUs: Security, Infrastructure, **Workloads** (dev, test), plus (if Option A for I-2) a **shared-services** account.
- [ ] Dev and test accounts in region **ap-south-1**. AWS IAM Identity Center for human access (no IAM users/access keys).
- [ ] AWS Config recorder (or Control Tower) in dev and test (I-4). CloudTrail organisation trail.
- [ ] Note the 12-digit account IDs (dev, test, management) and the Workloads OU ID.

### 6.4 Terraform state buckets (one per account, created before `terraform init`)
- [ ] S3 bucket `hsp-dev-terraform-state` in dev and `hsp-test-terraform-state` in test (ap-south-1): **Block Public Access on**, **versioning on**, **SSE-KMS** default encryption, a bucket policy denying non-TLS access, access limited to the admin/IaC role.
- [ ] Copy `infra/envs/<env>/backend.hcl.example` → `backend.hcl` and `terraform.tfvars.example` → `terraform.tfvars` (account ID, repo name). Both are git-ignored.
- [ ] Apply (I-1 fixed or Terraform ≥ 1.10): `terraform -chdir=infra/envs/dev init -backend-config=backend.hcl` → `plan` → `apply`. Repeat for test. Then from the management account: `infra/org` (management account ID, Workloads OU ID).

### 6.5 GitHub OIDC variables (no secrets are needed: OIDC replaces AWS keys)
Copy from `terraform output github_variables`:

| Scope | Variable | Value from |
|---|---|---|
| Repository variable | `AWS_CI_ROLE_ARN` | dev output `AWS_CI_ROLE_ARN` (or the shared-services account if Option A) |
| Repository variable | `ECR_REPOSITORY_URI` | dev output `ECR_REPOSITORY_URI` (or shared-services) |
| Environment `dev` variables | `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URI`, `AWS_ACCOUNT_ID`, `TASK_EXECUTION_ROLE_ARN` | dev outputs |
| Environment `test` variables | same four | test outputs |
| Secrets | **none** | Never add AWS access keys to GitHub |

---

## 7. Exact actions to close Gate 1
1. **Decide I-2** (Option A recommended) and approve or decline the one-line **I-1** fix. Any approved change is made as a small reviewed commit before AWS apply. No other code changes.
2. **Accept ADR-022.**
3. Complete **§6.1–6.2**: GitHub plan, org, repo, teams, signing, first signed push, `apply-repo-protection.sh`, environment reviewers.
4. Confirm the first CI run is green and record proofs **G1–G9** (run links) in GATE-1-REPORT §2. Fix or formally risk-accept any scanner finding.
5. Complete **§6.3–6.5**: AWS accounts, Config, state buckets, `terraform apply` dev/test, org SCPs, GitHub variables.
6. Push to `main` and run the Deploy workflow to `dev`. Record proofs **A1–A7**.
7. When G1–G9 and A1–A7 are all recorded: change the Gate 1 decision from **PASS WITH CONDITIONS** to **PASS**, sign the gate review, and then (separately) approve the start of Gate 2.
