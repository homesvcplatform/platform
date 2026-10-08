# Gate 1 Closure Checklist

> **Gate 1 status: PASS WITH CONDITIONS**, unchanged until every external proof in §3 and §4 is recorded. **AWS deployment is deferred by founder decision (2026-10-09)**: all AWS proofs (A1a–A8b) are deferred under temporary exception **TE-01** (§0). They are not waived. AWS does **not** block local/CI development.
> Gate 2: **not started.** TE-02 (amended 2026-10-09, narrow solo-development exception): Gate 2 may start when G1–G6 are PASS and the G7 interim protections are active and verified. G8/G9 stay pending until real members join, and AWS proofs stay deferred (TE-01). **That start condition is met**; Gate 2 waits for the founder's explicit "start Gate 2". **G1–G6 are proven in GitHub CI** ([run 37822630219](https://github.com/homesvcplatform/platform/actions/runs/37822630219), 2026-10-08). G7 is partial (interim ruleset verified); G8–G9 are pending. No scanner is claimed to pass beyond what the logs of that run show.
> Prepared 2026-10-08. Updated 2026-10-08 after the founder's decisions:
> - ADR-022 accepted.
> - I-1 fixed, I-2 Option A implemented, I-6 resolved.
> - Repository transferred to `homesvcplatform/platform`.
> - AWS account quota decision: TE-01/TE-02 recorded, registry amendments made.
> - First green GitHub CI run recorded: G1–G6 PASS (§3).
> - G7 partial: interim ruleset applied for single-member operation (TE-03, §0).
> - 2026-10-09: founder decision to defer AWS deployment. Development and testing use the `local` and CI environments; TE-01 widened to all AWS proofs; TE-02 approved.
> - 2026-10-09: TE-02 amended (organisation stays solo): new Gate 2 start condition G1–G6 PASS + G7 interim protections verified; G8/G9 and the final ruleset are mandatory before TE-03 closes.
>
> Companion to [GATE-1-REPORT.md](GATE-1-REPORT.md).

---

## 0. Temporary exceptions (founder-approved 2026-10-08)
**Context:** AWS Organizations refuses to create more member accounts because the organisation's account quota is reached. Only the management account and `housefi-shared-services` (Infrastructure OU) exist. A quota increase has been requested and is not assumed. The `housefi-dev` and `housefi-test` accounts can't be created yet.

**Rejected alternatives:**
- Running dev/test in the **management account**: SCPs never apply to the management account, so A4 would be unprovable. It is also against AWS guidance.
- Running dev/test in the **shared-services account**: it would put workloads next to the registry and CI build role, which is the separation I-2 restored.
- Combining dev and test in **one account**: isolation would be by IAM only, sharing account-wide settings and keys.
- A **second AWS organisation**: it would split guardrails and the audit trail.
- **LocalStack as evidence**: it doesn't faithfully enforce IAM or SCPs.
- **Inviting an existing account**: it counts against the same quota.

**The architecture is unchanged:** one account each for shared-services, dev and test, exactly as Phase 1 14 §2.1 and ADR-022 #11 specify.

### TE-01: AWS deployment deferred (all AWS proofs deferred)
**Founder decision (2026-10-09):** AWS is an **external deployment dependency that is deferred**. Account-quota issues must not block engineering. The AWS architecture (Phase 1 14 §2, ADR-022 #11) and all Terraform under `infra/` stay in the repository as the **intended future deployment target**. They are unchanged, still validated and scanned on every PR (G5: `terraform fmt`/`validate` + Checkov), and are **not applied**. No other cloud or hosting platform replaces them.

| | |
|---|---|
| **What is deferred** | **All AWS proofs: A1a, A1b, A2, A3, A4, A5, A6, A7, A8a, A8b** (§4). A1b, A2, A4, A7 and A8b are additionally blocked by the account quota (no dev/test accounts). A1a, A3, A5, A6 and A8a are technically possible with shared-services but deferred by the founder decision. Also deferred: image push and keyless signing to ECR (the `image` job builds, scans and produces the SBOM but doesn't push or sign), the `supply-chain-selftest` job (skipped while the AWS variables are unset), and the `Deploy` workflow. The SR-16 signed-deploy path is therefore unproven in AWS |
| **What proceeds now** | All development and testing on the **`local` environment and GitHub Actions CI** (Phase 1 14 §1, Phase 1 13): PostgreSQL 17 + PostGIS, Valkey, MinIO (S3-compatible), fake/sandbox providers (`packages/adapters/*`), synthetic data only. The GitHub proofs G1–G9 are unaffected by TE-01 |
| **Rules while TE-01 is open** | (1) **No AWS infrastructure is created or applied**, and no AWS credentials or variables are added to GitHub or the repository. (2) When AWS resumes: no workload resources in any account other than dedicated dev/test accounts in the Workloads OU, and no account consolidation. (3) `consumer_account_ids` in shared-services stays empty until real dev/test account IDs exist; **never** use placeholder IDs. (4) No production environment, production credentials, real PII, real payments, production telephony or production KYC anywhere (unchanged global rules). (5) Security boundaries and environment rules are unchanged: B1–B12, the no-production guardrails, and `APP_ENV` limited to the existing non-production values. (6) The quota request may stay open. Resolving it doesn't oblige immediate AWS work; resuming AWS is a separate founder decision |
| **Removal condition** | The founder decides to resume AWS, dev and test accounts exist in the Workloads OU, and **all** A-proofs (A1a–A8b) are recorded. Then TE-01 is closed in this file |
| **Risks** | (a) The Terraform stays unexercised in real AWS (only `validate` + Checkov in CI). (b) The supply-chain controls that need a registry (push, keyless signing, SBOM attestation, signed-deploy verification) stay unproven end to end. (c) Local containers differ from managed services (RDS, ElastiCache, S3), mitigated by TE-02 restriction (4) and the RDS re-run condition. (d) **Gate 1 can't reach PASS while TE-01 is open.** TE-02 keeps Gate 3 closed until Gate 1 is PASS or the founder decides otherwise, so **continuing to Gate 3 without AWS will need an explicit founder decision at that point** |

### TE-02: Gate 2 may start before Gate 1 is PASS (narrow solo-development exception)
| | |
|---|---|
| **Rule being excepted** | [03-phase-2-gates.md](03-phase-2-gates.md): Gate 2 depends on Gate 1, and "nothing merges into a later gate's scope until its prerequisites pass" |
| **History** | Approved 2026-10-08 with start condition "G1–G9 recorded". **Amended by founder decision 2026-10-09:** the GitHub organisation stays solo for now (TE-03) and AWS deployment is deferred (TE-01). G7 can therefore only be met by the interim ruleset, and G8/G9 can't be proven until real members join. The start condition below replaces the previous one |
| **Why it is safe** | Gate 2's deliverables and exit criteria (migrations, schemas, per-process DB roles and grants, constraints, append-only triggers, synthetic seed loader) need no AWS. Phase 1 13 already runs integration tests on ephemeral Postgres + PostGIS containers in CI. The interim ruleset forces every Gate 2 change through a PR with all 6 CI checks green (boundaries, secrets, SAST, SCA, IaC, image), signed and linear history, squash merge only |
| **Start condition (amended 2026-10-09)** | (a) **G1–G6 = PASS** (§3). (b) **G7 = interim protections active and verified:** ruleset `main-protection-interim` is active and verified by API read-back, the live push-rejection test passed, and the signed-commit rule was proven on PR #3 (§3, TE-03). (c) **G8 and G9 remain pending** until additional real organisation members are added. They are **not** a start condition, but are mandatory before closing TE-03 (restriction 9). (d) **AWS proofs remain deferred under TE-01.** They are not a start condition. **Trigger:** the founder's explicit instruction "start Gate 2" |
| **Current status (2026-10-09)** | **Start condition met.** (a) G1–G6 PASS ([CI run 37822630219](https://github.com/homesvcplatform/platform/actions/runs/37822630219)). (b) Interim ruleset id 24743658 active. Direct push to `main` rejected with GH013. PR #3 merge was blocked by "Commits must have verified signatures" until its commits were signed, then merged by squash as `37cc47c`. (c) G8/G9 pending. (d) TE-01 open. **Gate 2 is not started:** it waits for the founder's explicit instruction |
| **Restrictions** | (1) **Local and GitHub CI only.** (2) **PostgreSQL 17 + PostGIS in throwaway test environments** (ephemeral containers, created and destroyed per test run; Valkey and MinIO containers only where a Gate 2 deliverable needs them). For managed-database fidelity, migrations and grant tests run as a **non-superuser** owner role (like the RDS master user, without SUPERUSER), on pinned Postgres/PostGIS versions that the managed service offers. (3) **Synthetic data only.** (4) **No AWS infrastructure or credentials**, no deploys, and no `infra/` changes unless separately approved. (5) **No production environment** (the no-production guardrails stay in force). (6) **No real customer PII, payments, telephony or KYC.** (7) **No Gate 3 implementation.** Gate 3 starts only when its existing gate conditions are satisfied, or after a new recorded founder decision. (8) **Gate 2 itself stays PASS WITH CONDITIONS** until the planned managed-database verification (migrations and grant-matrix tests re-run on RDS in dev) can happen; that is deferred with AWS (TE-01). (9) **The final GitHub ruleset (`main-protection.json`), G8 and G9 remain mandatory before closing the solo-development exception (TE-03).** (10) **The interim `main` protections must not be weakened.** Every Gate 2 change goes through a PR with the 6 required checks, signed commits, linear history and squash merge only; the bypass list stays empty; the ruleset may only be tightened. (Note: Docker isn't installed on the founder's workstation, so DB tests run in GitHub Actions unless the founder approves installing Docker locally) |
| **Removal condition** | Gate 1 is PASS (which needs TE-01 and TE-03 closed) **and** the Gate 2 managed-database verification is recorded |
| **Risks** | (a) Local Postgres differs from a managed database (superuser, extensions, parameter groups, IAM auth), mitigated by restriction (2) and the deferred managed-database verification (8). (b) Gate 2 changes sensitive paths (`db/migrations/`, module schemas including identity and payments). Until TE-03 closes, these merge without an independent reviewer; `two-reviewers-for-sensitive-paths` shows red but doesn't block. Mitigation: the 6 required CI checks. **Recommended:** when real members join, a retrospective two-person review of the Gate 2 sensitive-path changes before TE-03 is closed. (c) Precedent of starting a gate early, mitigated by the narrow scope, restrictions (1)–(10) and the removal condition |

### TE-03: interim ruleset while the organisation has a single member
| | |
|---|---|
| **Why** | The founder is intentionally the only member of `homesvcplatform` for now. The final ruleset (`.github/rulesets/main-protection.json`) requires one approving review plus code-owner review, and GitHub never lets authors approve their own pull requests. With an empty bypass list, a sole member could never merge anything |
| **What is active now** | Ruleset **`main-protection-interim`** ([id 24743658](https://github.com/homesvcplatform/platform/rules/24743658), definition in `.github/rulesets/main-protection-interim.json`), applied 2026-10-08 on the default branch, enforcement **active**, **empty bypass list**. It blocks deletion and force pushes, and requires linear history, signed commits and a pull request (0 approvals, stale approvals dismissed, conversations resolved, **squash merge only**). The 6 status checks `verify`, `secrets-scan`, `sast`, `sca`, `iac`, `image` must come from GitHub Actions (integration 15368), and the branch must be up to date |
| **Deferred (intentionally not enabled)** | 1 required approval · code-owner review · approval of the most recent push by someone else · `two-reviewers-for-sensitive-paths` as a required check. Each needs a second person, and enabling them now would make `main` unmergeable. The two-reviewer workflow still runs on every PR, so a sensitive-path PR shows a red (non-blocking) check |
| **Unchanged** | The final `main-protection.json` is the target model. Nothing in it was weakened or edited |
| **Risk while open** | One person can change `main`, including sensitive paths, without a second reviewer. Mitigations: every change must go through a PR with all 6 CI checks green (including the gitleaks, Semgrep, OSV, Checkov and Trivy self-tests), no force pushes or branch deletion, signed history (GitHub signs squash merges), and two-factor authentication on the founder account (recommended, §6.1) |
| **Removal condition** | Mandatory before this solo-development exception can close (TE-02 restriction 9). At least **3 people with Write access**, including the founder, in the CODEOWNERS teams: for normal PRs an author plus one code-owner approver, and for sensitive paths an author plus two approvers. Then replace `main-protection-interim` with `main-protection.json`, prove G7 in full, then G8 and G9, and close TE-03 |

---

## 1. Architecture changes recorded in this gate: ADR-022
Gate 1's structural changes are recorded in [ADR-022](../phase-1/15-architecture-decisions.md#adr-022-gate-1-foundation-decisions-phase-2-implementation-addendum) and must stay explicit in the gate review:
- **Dependency-inversion ports for TCP-2 and TCP-3.** `jobs/public` declares `MaterialUsageRecorder` and `BillIssuer`. `diagnosis` and `payments` implement them, and apps wire them. Without this, calls from `jobs` → `diagnosis` and `jobs` → `payments` create import cycles (`diagnosis` → `jobs`, `payments` → `diagnosis` → `jobs`). Transaction semantics are unchanged. `payments` gains a compile-time dependency on `jobs` (recorded in `tools/architecture/modules.json`).
- **`OtpSender` port** owned by `identity`, implemented by `comms`. This removes an `identity` ↔ `comms` cycle present in the Phase 1 text.
- **Shared-services registry (ADR-022 #11, I-2 Option A).** The ECR repository and the CI build role move from each workload account to the shared-services account, as Phase 1 14 §2.1 specifies. See §5 for exactly what changed, including the 2026-10-08 registry amendments.
- Other ADR-022 items (toolchain pins, Node type stripping, framework timing, distroless image, keyless signing, X86_64, naming, web-bff treated as frontend) are implementation choices under approved decisions.
- **ADR-022 ACCEPTED by the founder on 2026-10-08** (status updated in docs/phase-1/15). Item #11 was added afterwards under the founder's I-2 Option A approval, and its amendment under the TE-01 decision.
- TE-01 and TE-02 are **temporary exceptions, not architecture changes**, so they are recorded here (§0), not as ADRs.

---

## 2. Already proven locally (`pnpm run ci` and the Terraform cross-reference check re-run 2026-10-08 after the registry amendments; other rows are from the original Gate 1 run, and no application code has changed since)
| Proof | Evidence |
|---|---|
| `pnpm run ci` passes | no-prod guard ✔ · workspace check ✔ · ESLint ✔ · strict typecheck **53/53** ✔ · dependency-cruiser **0 violations** (83 modules) ✔ · Vitest **92/92** ✔ |
| Boundary violations fail | Planted B1/B3/B7 violations in the real repo → `pnpm run arch` exit 4 with 4 errors. 13-case self-test suite detects every active rule + cycles + unresolvable imports, with no false positives |
| No-production guardrails | `APP_ENV=production`, `PROD_*` variables, and non-allowlisted AWS accounts are refused at boot. `prod` isn't a valid config value. Repo guard finds no prod environment (including `infra/envs/shared-services`) |
| Config validation | Invalid config refused. Error names keys but never values |
| Role boot | `api` starts locally and serves `/healthz` |
| Deploy controls (offline part) | Non-digest image refs refused. Unverifiable signature → refused (fail-closed). `prod`/`production` targets refused by the task-definition renderer. Rendered task definition is non-root, has a read-only root FS, drops all capabilities, and is digest-pinned |
| Dependencies | `pnpm audit`: no known vulnerabilities (npm advisory DB, **not** OSV-Scanner) |
| CI definitions | All 3 workflows + Dependabot + Semgrep/Checkov configs parse. 23/23 action references are SHA-pinned. Base images pinned by digest |
| Terraform cross-references (scripted, **not** `terraform validate`) | For `envs/shared-services`, `envs/dev`, `envs/test` and `org`: every module argument is a declared variable, every required variable is passed, every `module.*.*` output and `var.*` reference exists, brackets balance. No module still uses the removed `ecr` key |

**Not proven locally:** Docker build, gitleaks, Semgrep, OSV-Scanner, Checkov, Trivy, Syft, cosign, and **`terraform fmt/validate/plan/apply`**. These tools aren't installed on this machine and none were installed. Terraform formatting and validation of the I-1/I-2/I-6 changes and the registry amendments is **CI-only** (proof G5).

---

## 3. Must be proven in GitHub CI (no TE-01 impact)
**Evidence run:** [CI run 37822630219](https://github.com/homesvcplatform/platform/actions/runs/37822630219) on `main`, commit `f24d451` (2026-10-08). Every job succeeded. `supply-chain-selftest` was skipped by design because the AWS repository variables don't exist yet (that is proof A6, §4). Each result below was read from that run's job log on GitHub.

| # | Proof | Pass criterion | Status | Evidence (from the job log) |
|---|---|---|---|---|
| G1 | `verify` job | Green on a clean runner (frozen lockfile install, full `pnpm run ci`) | **PASS** | `pnpm install --frozen-lockfile` (lockfile up to date) · no-prod guard passed · workspace check passed · typecheck 53/53 · dependency-cruiser 0 violations (83 modules) · Vitest 92/92 |
| G2 | `secrets-scan` | gitleaks over full history finds nothing **and** the planted-secret self-test step reports "Planted secret detected as expected" | **PASS** | gitleaks: 6 commits scanned, "no leaks found". Self-test: "leaks found: 1", "Planted secret detected as expected." |
| G3 | `sast` | Semgrep (registry default + project rules) finds nothing blocking **and** the planted-code self-test flags the insecure file | **PASS** | Semgrep 1.180.0: 368 rules on 326 files, 0 findings. Self-test: 3 blocking findings on the planted file, "Planted insecure code flagged as expected." |
| G4 | `sca` | OSV-Scanner reports no known vulnerabilities in `pnpm-lock.yaml` | **PASS** | OSV-Scanner v2.6.0: "Scanned /src/pnpm-lock.yaml file and found 205 packages", "No issues found" |
| G5 | `iac` | `terraform fmt -check` and `validate` pass for `envs/shared-services`, `envs/dev`, `envs/test`, `org`. Checkov passes on `infra/` **and** the insecure-fixture self-test reports failed checks | **PASS** | Terraform 1.16.5: `fmt -check` passed, and "Success! The configuration is valid." for all 4 roots. Checkov 3.3.26: 496 passed, **0 failed**, 43 skipped (each an inline justified skip). Self-test: 3 resources, 14 failed checks, "flagged as expected" |
| G6 | `image` | Docker build succeeds. Trivy finds no fixable HIGH/CRITICAL issues. CycloneDX SBOM artifact uploaded | **PASS** | Image built (runtime Debian 13.7, distroless). Trivy v0.75.0: 0 findings (OS and Node packages). SBOM artifact `hsp-backend_<sha>.cyclonedx.json` uploaded. **Not pushed or signed**, because AWS isn't configured; push and signing are proof A5 |
| G7 | Ruleset enforcement | Direct push to `main` rejected. A PR can't merge with any required check red. An unsigned commit is rejected. Code-owner review is required and the `@homesvcplatform/*` teams resolve | **PARTIAL (TE-03)** | **Configured, verified by API read-back** (2026-10-08): `main-protection-interim` is active on the default branch with an empty bypass list. It blocks deletion and force pushes, and requires linear history, signed commits, a PR (0 approvals, squash only, conversations resolved) and the 6 checks from GitHub Actions on an up-to-date branch. **Demonstrated live (2026-10-09):** (1) The founder pushed an empty test commit directly: `git push origin HEAD:main` was refused with "GH013: Repository rule violations found for refs/heads/main … Changes must be made through a pull request … 6 of 6 required status checks are expected … push declined due to repository rule violations". `main` stayed at `f585de2`. (2) On PR #3, GitHub shows "Merging is blocked: Commits must have verified signatures" (the PR commit was made on a workstation without commit signing), so the signed-commit rule is enforced. All 6 CI checks are marked **Required**, while `two-reviewers-for-sensitive-paths` fails but is **not** required (TE-03, as designed). **Still to show:** a merge blocked solely by a red required check (e.g. the G8 PR). **Not provable with one member (deferred, TE-03):** required approval, code-owner review, and resolution of the `@homesvcplatform/*` teams |
| G8 | Boundary check blocks a PR | A throwaway PR that adds a deep cross-module import → `verify` red (then close the PR) | **PENDING (GitHub test)** | Not proven in CI. Proven locally only (§2: planted violations make `pnpm run arch` exit 4). Needs a throwaway PR |
| G9 | Two-approval rule | A throwaway PR touching `infra/` with one approval → `two-reviewers-for-sensitive-paths` red. With two approvals → green | **PENDING (GitHub setup + test)** | Not proven. **Control fixed 2026-10-08, before testing:** the check counted approvals from anyone. On this public repo any GitHub user can submit an "Approve" review, so two outsiders could have satisfied it. It now counts only each reviewer's latest APPROVED review from people with write/admin access, excluding the PR author, and fails closed if the permission is unknown. The workflow has run on the Dependabot PRs, but they touch no sensitive path. Needs two humans with write access and a throwaway PR touching `infra/` |

**Earlier runs (failed, fixed, kept for the record):**
- **Run 37819790355** (`6ea5830`) failed `iac`, `sast` and `image`.
- **Run 37822219298** (`4971643`) failed only the Checkov self-test assertion.

The root causes and fixes are in commits `4971643` and `f24d451`, summarised in [GATE-1-REPORT §2a](GATE-1-REPORT.md#2a-github-ci-evidence-2026-10-08). No check was weakened.

**Caveat:** Semgrep's `p/default` and the vulnerability databases (OSV, Trivy) change over time. A later red run may be a newly published rule or CVE, not a regression. Any scanner finding is fixed or explicitly risk-accepted before closure.

## 4. Must be proven in AWS (all deferred under TE-01; AWS deployment deferred by founder decision 2026-10-09)
None of these proofs is needed for local/CI development. They remain required for Gate 1 **PASS**.

| # | Proof | Pass criterion | Status |
|---|---|---|---|
| A1a | Shared and org infrastructure applies | `terraform apply` succeeds for `infra/envs/shared-services` (with `consumer_account_ids = []`) and `infra/org` | **Deferred (TE-01, founder decision)** |
| A1b | Workload infrastructure applies | `terraform apply` succeeds for dev and test. No public subnets in use, no public RDS/Valkey, data subnets have no internet route. dev/test contain **no** ECR repository | **Deferred (TE-01) + blocked by the account quota** |
| A2 | No public buckets | Attempt to set a public bucket policy/ACL in dev → denied (account-level block). AWS Config rules `s3-public-access-prohibited` and `s3-account-public-access` show COMPLIANT | **Deferred (TE-01) + blocked by the account quota** |
| A3 | Org guardrails | Applied from the management account. All three `infra/org` SCPs are attached to the **Workloads OU** (it may still be empty). `hsp-region-allowlist` and `hsp-security-baseline` are attached to the **Infrastructure OU** (I-6). In shared-services, a regional call outside ap-south-1/ap-south-2 (e.g., `aws ecr describe-repositories --region us-east-1`) → **AccessDenied (explicit deny in SCP)** | **Deferred (TE-01, founder decision)** |
| A4 | Only the pipeline can deploy | From a non-deploy principal (e.g., your SSO admin role in dev), `aws ecs register-task-definition …` → **AccessDenied (explicit deny in SCP)**. The `ecs-out-of-band-change` alert fires to the SNS topic | **Deferred (TE-01) + blocked by the account quota** |
| A5 | Signed image published | A push to `main` → `image` job (CI build role in **shared-services**) pushes to `hsp-shared-backend`, keyless-signs and attaches the SBOM attestation (digest shown in the job summary) | **Deferred (TE-01, founder decision)** |
| A6 | Unsigned image refused | The `supply-chain-selftest` job is green ("Unsigned image refused as expected") | **Deferred (TE-01, founder decision)** |
| A7 | Signed deploy path works, cross-account | `Deploy` workflow to **`dev` and then `test`** with the same signed digest → verification of the shared-registry image passes in each and 7 task definitions are registered in each | **Deferred (TE-01) + blocked by the account quota** |
| A8a | Only CI can push | From a shared-services principal other than `hsp-shared-ci-build` (e.g., your SSO admin role), pushing an image to `hsp-shared-backend` → **AccessDenied (explicit deny in the repository policy)**. The CI build role's push still succeeds (A5) | **Deferred (TE-01, founder decision)** |
| A8b | Only runtime/deploy roles can pull | From a dev principal that is neither `hsp-*-task-execution` nor `hsp-*-deploy` (e.g., your SSO admin role), `aws ecr batch-get-image` on `hsp-shared-backend` → **AccessDenied**. The deploy and execution roles can pull (A7) | **Deferred (TE-01) + blocked by the account quota** |

*A8 was split on 2026-10-08. The earlier single A8 claimed that any non-CI push is denied. Before the registry amendment that was not true for administrators inside shared-services, because a same-account IAM allow is enough without a resource-policy deny.*

---

## 5. Issues found while preparing this checklist
| # | Issue | Status |
|---|---|---|
| I-1 | `infra/envs/*` and `infra/org` declared `required_version >= 1.9.0`, but `backend.hcl.example` uses `use_lockfile = true` (S3-native state locking needs Terraform ≥ 1.10) | **FIXED 2026-10-08 (founder-approved).** Now `required_version = ">= 1.10.0"` in `infra/envs/{dev,test}`, `infra/org` and `infra/envs/shared-services` |
| I-2 | **Deviation from Phase 1 14 §2.1:** Gate 1 placed the ECR repository and CI build role **in each workload account**, but Phase 1 places them in a **shared-services account**. CI pushes to one registry, so `deploy.yml` to **test** would have looked for the image in test's own ECR, where it doesn't exist | **IMPLEMENTED 2026-10-08 (founder-approved Option A, ADR-022 #11), amended 2026-10-08** (see "Registry amendments" below). Unproven until G5 and A1a/A1b, A5, A7, A8a/A8b |
| I-3 | Rulesets on **private** repos need a paid GitHub plan (Team or higher for organisations). Secret-scanning push protection on private repos needs GitHub Secret Protection (paid) | **Open, founder action** (§6.1). The repository is now in the `homesvcplatform` organisation. Without the plan, G7 can't be proven and `apply-repo-protection.sh` partially fails. gitleaks in CI covers secret detection either way |
| I-4 | AWS Config rules (guardrails module) need an AWS Config recorder in each workload account | **Open, founder action, blocked by TE-01** (§6.3). Enable AWS Config (or Control Tower) in dev/test when they exist, or apply once with `enable_config_rules = false` and accept that A2's Config evidence is missing. Not needed in shared-services (no guardrails module there) |
| I-5 | `tools/deploy/verify-image.sh` was staged early to keep its executable bit | **Resolved.** Committed in the initial commit `6a9a529` |
| I-6 | **Shared-services had no SCP treatment in code.** `infra/org` attached the SCPs to the Workloads OU only. Phase 1 14 §2.1 draws SCPs at the organisation Root | **RESOLVED 2026-10-08 (founder decision: option a).** The existing `hsp-region-allowlist` and `hsp-security-baseline` SCPs are now also attached to the Infrastructure OU. No new policy text. Unproven until G5 and A3. The account-level guardrails module (S3 account public-access block, EBS default encryption, Config rules, ECS drift alert) is still applied only in dev/test. That is unchanged and outside this decision |
| I-7 | GitHub repository first created as `sujal128005/housefi` (personal account, brand name). CODEOWNERS teams can't exist there, and the OIDC trust and signature identity bind to owner/repo | **RESOLVED 2026-10-08 (founder action).** Transferred and renamed to **`homesvcplatform/platform`**, matching ADR-021, CODEOWNERS and the tfvars examples, before any AWS trust was created. No code change needed |
| I-8 | The registry module required a non-empty `consumer_account_ids`, so shared-services couldn't be applied before dev/test exist. A8 overstated push protection (see §4 note) | **FIXED 2026-10-08 (founder-approved).** See "Registry amendments" below |

### Registry amendments (2026-10-08, founder-approved with the TE-01 decision)
- **`infra/modules/registry`:**
  - `consumer_account_ids` may be **empty**. Each entry must still be a 12-digit ID.
  - When it's empty, the cross-account pull statement (repository policy) and the consumer decrypt statement (key policy) are omitted, so there is no cross-account access at all.
  - When it's non-empty, both statements are exactly as before.
- **New explicit Deny in the repository policy** (`OnlyCiBuildRolePushes`):
  - It denies `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart` and `ecr:CompleteLayerUpload` to every principal whose `aws:PrincipalArn` isn't `arn:aws:iam::<shared-services>:role/hsp-shared-ci-build`.
  - The ARN is built from `name_prefix`, the same name `infra/modules/ci-build` creates, so the modules don't depend on each other.
  - The repository policy therefore always exists.
  - Checkov's public-policy check (CKV_AWS_32) uses cloudsplaining, which ignores Deny statements in its source, so the `"*"` principal in a Deny shouldn't count as a public grant. Confirmed only when Checkov runs in CI (G5).
- **`infra/envs/shared-services`:** the `consumer_account_ids` description and `terraform.tfvars.example` now say to leave it empty until dev/test exist and never to use placeholders.
- **ADR-022 #11:** amendment note added.
- **Unchanged:** dev/test Terraform, the `ci-build` module, `infra/org`, workflows, deploy tooling and application code.

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
  - Push stays with the CI build role in the same account. It is enforced by an explicit Deny since the registry amendments.
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
- [x] Organisation **`homesvcplatform`** and repository **`homesvcplatform/platform`** (transferred and renamed 2026-10-08, I-7).
- [ ] Choose the GitHub plan for the organisation (see I-3).
- [ ] Create teams with **Write** access (CODEOWNERS requires it): `engineering`, `platform-leads`, `security`, `payments`, `voice`. **At least 2 humans** must be able to approve sensitive paths.
- [ ] Every contributor sets up **commit signing** (SSH or GPG) before the ruleset is applied. The existing commits `6a9a529`… are unsigned. Push them before the ruleset is applied.
- [ ] Settings → Actions → General: "Read repository contents" default workflow permissions. Don't allow Actions to approve PRs.
- [ ] Settings → Code security: enable Dependabot alerts (and secret scanning/push protection if the plan allows).

### 6.2 Branch / ruleset protection
- [x] Push the current `main` to `homesvcplatform/platform` (done; head `f585de2`, CI green).
- [x] **Interim ruleset applied** (`main-protection-interim`, TE-03). From now on every change to `main` goes through a PR: push a branch, open a PR, wait for the 6 checks, then **squash merge**.
- [x] **Live G7 test done 2026-10-09:** the direct push was rejected with GH013 (pull request required, 6 required checks). Was: make any throwaway commit on a local branch, then run `git push origin HEAD:main`. Expected: rejected with `GH013: Repository rule violations found`, listing that changes must go through a pull request and that commits must have verified signatures. Nothing reaches `main`. Discard the throwaway commit afterwards. Paste the rejection output so it can be recorded.
- [ ] **Commit signing is now required to merge anything** (live finding on PR #3): every commit in a PR must be verified. Set up SSH or GPG signing for each machine that commits (this workstation included) and add the public key to GitHub as a **Signing key** (Settings → SSH and GPG keys). Commits made in the GitHub web editor and by Dependabot are signed by GitHub automatically.
- [ ] **Later (removes TE-03):** with at least 3 Write-access members in the CODEOWNERS teams, replace the interim ruleset with `.github/rulesets/main-protection.json` (Settings → Rules → Rulesets → New ruleset → Import a ruleset; then delete `main-protection-interim`), and enable environment reviewers.
- [ ] Create environments `dev`, `test` (deployments from protected branches only) and add **required reviewers**. Required reviewers are available on Free because the repo is public. With one member, the founder is the only reviewer. That is still a deliberate approval gate on deploys and doesn't block solo operation.

### 6.3 AWS accounts (non-production only)
> **Deferred (TE-01, founder decision 2026-10-09).** §6.3–§6.5 are kept as the runbook for when AWS resumes. Don't create or apply AWS infrastructure, and don't add AWS variables to GitHub, while TE-01 is open.

- [x] AWS Organization, management account, OUs **Infrastructure** and **Workloads**, and `housefi-shared-services` in Infrastructure.
- [ ] Security OU (per Phase 1 14 §2.1), when quota allows. Not required for Gate 1 proofs.
- [ ] **TE-01:** `housefi-dev` and `housefi-test` in **Workloads** once the account quota allows. Keep the quota request open (Support case and/or a Service Quotas request for AWS Organizations).
- [ ] AWS IAM Identity Center for human access (no IAM users/access keys). CloudTrail organisation trail.
- [ ] AWS Config recorder (or Control Tower) in dev and test when they exist (I-4).
- [ ] Note the 12-digit account IDs (management and shared-services now; dev and test later), the **Workloads OU ID** and the **Infrastructure OU ID** (both required by `infra/org`).

### 6.4 Terraform state buckets and apply order (Terraform ≥ 1.10)
**Now (TE-01 open):**
- [ ] State bucket `hsp-shared-terraform-state` in shared-services (ap-south-1): **Block Public Access on**, **versioning on**, **SSE-KMS** default encryption, a bucket policy denying non-TLS access, and access limited to the admin/IaC role. The org root uses its own state bucket in the management account, with the same settings.
- [ ] `infra/envs/shared-services`: copy `backend.hcl.example` → `backend.hcl` and `terraform.tfvars.example` → `terraform.tfvars` (both git-ignored). Set `account_id` and `github_repository = "homesvcplatform/platform"`, and **keep `consumer_account_ids = []`**. Run `terraform -chdir=infra/envs/shared-services init -backend-config=backend.hcl` → `plan` → `apply`.
- [ ] `infra/org` from the management account (`management_account_id`, `workloads_ou_id`, `infrastructure_ou_id`). Attaching the SCPs to the still-empty Workloads OU is fine.

**Later (closes TE-01):**
- [ ] Create `hsp-dev-terraform-state` / `hsp-test-terraform-state` in the new accounts, with the same settings.
- [ ] **Re-apply shared-services** with `consumer_account_ids = ["<real dev id>", "<real test id>"]`. This adds the cross-account pull and decrypt statements in place.
- [ ] dev, then test: copy `terraform output workload_inputs` from shared-services into each `terraform.tfvars` (`shared_ecr_repository_arn`, `shared_ecr_repository_url`, `shared_ecr_kms_key_arn`), plus `account_id` and `github_repository`. Then `init -backend-config=backend.hcl` → `plan` → `apply`.
- [ ] **Order caveat:** the org SCPs will already be attached to Workloads when dev/test are created. `hsp-security-baseline` denies `s3:PutAccountPublicAccessBlock` to everyone except `OrganizationAccountAccessRole`. The guardrails module sets that block, so run the **first** dev/test apply as `OrganizationAccountAccessRole`, or that step is denied.

### 6.5 GitHub OIDC variables (no secrets are needed: OIDC replaces AWS keys)
| Scope | Variable | Value from | When |
|---|---|---|---|
| Repository variable | `AWS_CI_ROLE_ARN` | **shared-services** output `github_variables.AWS_CI_ROLE_ARN` | Now |
| Repository variable | `ECR_REPOSITORY_URI` | **shared-services** output `github_variables.ECR_REPOSITORY_URI` | Now |
| Environment `dev` variables | `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URI`, `AWS_ACCOUNT_ID`, `TASK_EXECUTION_ROLE_ARN` | dev output `github_variables` (its `ECR_REPOSITORY_URI` equals the shared one) | After TE-01 |
| Environment `test` variables | same four | test output `github_variables` | After TE-01 |
| Secrets | **none** | Never add AWS access keys to GitHub | |

---

## 7. Exact actions to close Gate 1
1. ~~Decide I-2 and I-1.~~ **Done** (2026-10-08).
2. ~~Accept ADR-022.~~ **Done** (2026-10-08). Item #11 records I-2 and its amendment.
3. ~~Decide **I-6**.~~ **Done** (2026-10-08).
4. ~~Move the repository to `homesvcplatform/platform` (I-7).~~ **Done** (2026-10-08).
5. ~~Commit the registry amendments and the TE-01/TE-02 docs.~~ **Done** (`6ea5830`).
6. **§6.1–6.2:** interim ruleset **applied** (TE-03, G7 partial). Remaining: the live push-rejection test, environments, and (later, with more members) the teams, signing for contributors and the final ruleset.
7. ~~Confirm the first CI run is green~~ **Done:** G1–G6 PASS in [run 37822630219](https://github.com/homesvcplatform/platform/actions/runs/37822630219) (§3). **Remaining:** G7, G8, G9, which need §6.1–6.2 plus throwaway PRs. When G7–G9 are recorded, TE-02's start condition is met, and Gate 2 then needs the founder's explicit "start Gate 2".
8. **Deferred (TE-01):** the "Now" part of §6.4 and the shared-services repository variables in §6.5, then record A1a, A3, A5, A6, A8a. Only after the founder decides to resume AWS.
9. **Deferred (TE-01):** when AWS resumes and the dev/test accounts exist, do the "Later" part of §6.4 and the environment variables in §6.5. Run the Deploy workflow to `dev` and `test`. Record A1b, A2, A4, A7, A8b, then close TE-01.
10. When G1–G9 and all A-proofs are recorded: change the Gate 1 decision from **PASS WITH CONDITIONS** to **PASS** and sign the gate review. TE-02 closes once the Gate 2 RDS re-run is also recorded.
