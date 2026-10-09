# Gate 3 Review: Identity, authentication, authorization

> Date: 2026-10-09 · Decision: **PASS WITH CONDITIONS** (see §6) · Started under **TE-02** (founder decision 2026-10-09, restriction 7 amended). Local and GitHub CI only, synthetic fixtures, fake SMS, test IdP, `kms-local`. No AWS, production, real PII, payments, telephony or KYC. Gate 4 **not started**.
> Branch `gate3/identity-auth`, [PR #6](https://github.com/homesvcplatform/platform/pull/6) (draft; the founder squash-merges). Decisions: [ADR-024](../phase-1/15-architecture-decisions.md#adr-024-gate-3-identity-authentication-and-authorization-decisions-phase-2-implementation-addendum) (Proposed).

## 1. Scope delivered vs planned ([03 §Gate 3](03-phase-2-gates.md#gate-3-identity-authentication-authorization))
| Planned | Delivered |
|---|---|
| Phone OTP (fake SMS adapter) | `identity`: 6-digit CSPRNG codes stored as HMAC(pepper, challenge ‖ code), 5 min expiry, 5 attempts, 30 s cooldown, 5/h and 10/day per phone (DB), per-IP and per-device buckets, global breaker → bot check. Identical response for known and unknown numbers. Only the reserved fake range is accepted in Phase 2. `sms-fake` adapter |
| Sessions, refresh rotation with reuse detection | Technician app: ES256 access token (10 min, pinned algorithm, audience `tech-app`) + opaque refresh token (SHA-256 stored, 30-day sliding / 90-day absolute, device-bound). Reuse or a foreign device revokes the family and the session; a retry within 10 s gets the same successor. Suspension and erasure revoke every session |
| BFF cookie sessions (customer + agent web) | `__Host-sid` (HttpOnly, Secure, SameSite=Lax, Path=/), secret hash only; `api` validates it (G-6). CSRF token + allowed Origin on every mutation. Agent sessions are unusable until the second factor. No token ever in a browser response body |
| Signed client-IP header over mTLS (G-6 / SR-10) | `resolveClientIp`: X-Forwarded-For is never read; a signed, fresh `X-Client-IP` is honoured only from the BFF's mTLS identity. Rate limits key on the resolved IP. (mTLS itself is deployment: condition) |
| Step-up | Public: a fresh STEP_UP OTP on the current session (10 min). Admin: WebAuthn assertion (5 min) |
| IVR PIN credential store | Argon2id (Node built-in, PHC), trivial PINs refused, 3 wrong per call ends the call, 5 wrong in 24 h locks until a verified reset |
| Admin SSO via a test IdP + passkey enforcement | `backoffice`: IdP / proxy ES256 assertion required on every request together with the admin session; SMS / OTP / TOTP / password methods refused (`hwk` or `acr=phr/phrh` required); one concurrent session, 10 h / 30 min. Passkey registration (first one only right after login) and step-up; maker-checker role grants (three people, payload hash, executed once). Test IdP and software authenticator in `@hsp/testing` |
| Idempotency (04 §1.3) | `POST /admin/v1/grants` requires `Idempotency-Key`: a retry replays the first response (one approval request), the key with another body → 422, a key in flight → 409 + Retry-After, keys scoped per admin, 24 h retention (ADR-024 #16) |
| Policy engine + registry | `@hsp/policy`: `can(actor, action, resource, ctx)`, default deny, scoped admin permissions (wildcard families), decision logging, endpoint registry check (B11 / B12) at composition |
| Audit log (hash-chained) | `platform.append_audit_log` (SECURITY DEFINER) + `compliance.verify_audit_chain`; direct INSERT revoked from every runtime role; `change_summary` limited to field names and enum-like values |
| Field crypto with per-class keys + encryption context (SR-06) | `@hsp/security` envelope (AES-256-GCM), one DEK per (subject, data class), context {subject_id, data_class}, DEK cache ≤ 5 min, crypto-shredding on erasure; `kms-local` enforces the SR-06 role grants; ESLint restricts `createFieldCrypto` to the reveal paths |
| Allowlist logger + canary-PII test | Field allowlist + new value net (phones, short codes, JWTs, long secrets, e-mails dropped and counted); canary scan over logs, audit rows and responses |
| Rate limiter | Token buckets behind a store port (in-memory in local/CI; Valkey with deployment: condition) |
| Errata | G-6, SR-02, SR-03 (passkey primitive), SR-06, SR-10, SR-14 (new-device hold rule), X-14, X-32 |

Supporting: `@hsp/errors` (problem+json, no internals), `@hsp/contracts` auth/admin DTOs (strict), migrations 0026–0028, app compositions `apps/api` / `apps/admin-api` (`bootstrap.ts`).

## 2. Exit criteria evidence
**GitHub CI [run 37856692548](https://github.com/homesvcplatform/platform/actions/runs/37856692548)** (commit `8052cc3`): every job succeeded (`supply-chain-selftest` skipped by design, TE-01). From the `verify` log: guards, lint, typecheck, 0 boundary violations (153 modules), **196/196 unit tests**, squawk "0 issues in 28 files", **test:db 11 files / 142/142 tests** (new in Gate 3: identity 20, admin realm + matrix 38, audit chain 5, canary 1; grants now 18).

| Exit criterion | Evidence |
|---|---|
| Authorization-matrix generator running for all implemented endpoints (default deny) | `@hsp/testing` `generateMatrixCases` expands all 38 × 15 cells of 05 §11 (data checked cell-for-cell against the doc). Implemented capabilities ("Revoke sessions", "Grant roles") are checked per cell with role permissions loaded from the DB, including out-of-relationship objects (404). The other 542 cells (other capabilities, break-glass column) must deny by default, and do. Every endpoint declares a policy + idempotency (B11/B12) or the composition refuses to start |
| ST-08 (OTP brute force, reuse, expiry) | 5 wrong codes invalidate the challenge; reuse and expiry give the same generic `OTP_INVALID` |
| ST-09 (OTP flood) | Per-phone cooldown / hourly cap (429 + Retry-After), per-IP bucket (20/h), global breaker → bot check |
| ST-10 (refresh reuse) | Reuse after 10 s or from another device revokes the family and the session (401 `SESSION_REVOKED`, audited); retry within 10 s returns the same successor |
| ST-11 (JWT alg=none, HS256 with the public key, wrong aud, expired) | All 401, at unit level and through the HTTP handler; foreign keys and tampering also refused |
| ST-12 (CSRF) | Mutations without the token, with a foreign Origin or without Origin → 403 (customer and admin realms) |
| ST-27 (X-Forwarded-For spoofing) | XFF never read; a signed `X-Client-IP` only from the BFF identity; a spoofed flood is limited on the real peer IP |
| ST-28 (deleted user, old token) | After erasure: old access / refresh tokens 401, PII nulled, subject key destroyed, a restored old ciphertext can't be decrypted |
| Refresh reuse revokes the family | ST-10 above |
| No tokens in browser storage (SR-02) | API level: browser surfaces get only an HttpOnly `__Host-` cookie; no token in any browser response body. Real-browser storage E2E is a Gate 8 condition (§6) |
| KMS decrypt denied for roles without the class grant | `kms-local` with SR-06 grants: the worker role can't reveal a phone (`KmsAccessDeniedError`); the api role can |
| Canary-PII scan: 0 hits | All identity flows run with a canary phone; logs, audit rows and error bodies contain no canary, OTP code, PIN, refresh token, access token or cookie secret; success bodies contain no canary PII |
| Also | Admin SSO refuses SMS / OTP / TOTP / password, foreign keys, wrong audience and over-long assertions; one concurrent admin session; passkey registration and step-up (origin, replay, other authenticator refused); maker-checker grant executes once, a tampered payload doesn't execute, INV-19 enforced by the DB; audit chain verifies under 25 concurrent writers and detects an edited, deleted or forged row; IVR PIN lockout; suspension revokes sessions |

### 2a. Issues found and fixed by CI before green
squawk lock-rule waivers on the empty `subject_keys` primary-key change; a JWT-shaped literal in a test (Semgrep); a permission CHECK that rejected wildcard families; the `roleCode` audit field (the audit validator refuses names containing `code`); the seed loader's subject-key insert (new `data_class`); a `credential_id` CHECK over PostgreSQL's regex repetition limit; adapters given an explicit test env (Vitest adds `PROD` to `process.env`, which the no-production guard correctly refuses).

## 3. Security review notes
- New threat surface is limited to framework-neutral handlers; no endpoint is served yet (ADR-024 #1).
- The audit chain serialises audited commits per month (head lock); acceptable at pilot volume.
- After an erasure, a process that already holds the subject's data key in its cache may still decrypt for up to 5 minutes (SR-06 bound); a process with a cold cache can't decrypt at all. Erasure does not revoke other processes' caches immediately. Tested across independent instances (review fix R6).
- Identity users are created at OTP request (ADR-024 #6); never-verified rows need the retention job.
- **The WebAuthn CBOR decoder is custom code without an independent security review** (ADR-024 #2). Hardened after review finding R4 and tested against the software authenticator and malformed-input cases, but **not reviewed**: passkey ceremonies are refused outside `local` / `test` in code until a scoped security review passes (§6 condition 2).
- The voice role has no DB grant on `identity.subject_keys`, so IVR can't reveal contact data yet (needed with the IVR gates; a grant migration then).

### 3a. Review fixes (2026-10-09)
Two independent AI review reports were verified finding by finding (ADR-024 R1–R6).

**Confirmed defects, fixed and tested:**
- R1 step-up was session-wide and its action label client-chosen → now bound to a server-validated operation, the approval request and its payload hash, consumed once in the decision transaction.
- R2 a city-only grant of `security.grant` could authorise global security administration → global-scope checks + global-only roles (API + DB trigger).
- R3 both compositions defaulted to the in-memory rate limiter → fail closed outside `local` / `test`.
- R5 concurrent logins could leave two active admin sessions → logins serialised per admin.

**Hardening (weakness, no exploit shown):** R4 CBOR decoder now rejects non-minimal encodings and enforces strict UTF-8, duplicate-key, size, item and depth limits; it remains unreviewed and disabled outside `local` / `test`.

**Accepted by design, documented:** R6 the ≤ 5 min DEK-cache window after erasure.

**Deployment-only (unchanged, §5):** the shared atomic (Valkey) rate-limit store itself, real KMS policies, mTLS.

**Second review round (ADR-024 R7–R12):** confirmed and fixed: the decision value bound into the step-up (R7), the first-passkey enrolment race (R9) and the NULL hole in migration 0029's CHECK (R10). 0029 now handles pre-existing data explicitly (R11). The concurrency tests were corrected (R8): only the database-level test, which asserts the lock wait via `pg_blocking_pids`, proves the single-use UPDATE guard; the API-level tests are serialised by row locks and are described as such.

**R12 decided (founder, 2026-10-09): session revocation is SECURITY_ADMIN only for now.** A deliberate Gate 3 security / product restriction. Users carry no city or region, so a city-scoped SUPPORT_L2 or region-scoped SAFETY_OFFICER couldn't be limited to their scope. Migration 0029 removes `security.sessions.revoke` from both roles, the 05 §11 matrix row reads ❌ for them, and the identity policy counts the permission only from a GLOBAL grant. Public users still revoke only their own sessions; the IVR surface still can't revoke. No city / region attribution or cross-module lookup was added. Broader scoped revocation can be revisited once the product defines city / region semantics for users.

**Repository control (owner action):** the live `main` ruleset (`main-protection-interim`, TE-03) requires 0 approvals and does **not** list `two-reviewers-for-sensitive-paths` as a required check. That is the documented TE-03 interim state for a single-member organisation (making it required now would block every merge, since authors can't approve their own PRs). The intended final ruleset (`.github/rulesets/main-protection.json`) does require it with 1 approval and code-owner review. Owner action, once a second human reviewer exists: apply the final ruleset (TE-03 removal). Not changed here: no admin access from this environment, and changing it is the owner's decision.

## 4. Tech debt register delta
| Item | Due |
|---|---|
| Choose the decorator-free HTTP library and add its adapter over the framework-neutral handlers (ADR-024 #1; NestJS rejected) | Before the first served endpoint (Gate 5/8) |
| Valkey rate-limit store; Valkey session denylist (DB check is the fallback today) | Deployment (TE-01) |
| Agent second-factor enrolment and completion (passkey / TOTP) | With the agent surface |
| Break-glass (05 §9), JIT elevation, PII-reveal workflow, access recertification | Their gates |
| Seed loader still uses the fixture crypto (ADR-023 #10 replacement) | When the seed CLI is composed with `kms-local` at app level |
| Encrypted idempotency response bodies (only needed once a `required` endpoint returns Confidential data) | First such endpoint |
| Never-verified users purge | Retention job |

## 5. Not verifiable without AWS (TE-01 / TE-02)
Real KMS key policies per data class and per role (`kms-local` enforces the same grants in CI), Secrets Manager for peppers and signing keys, the asymmetric KMS signing key, BFF↔api mTLS, Valkey, CloudTrail decrypt-rate alarms (SR-06), the zero-trust proxy in front of `admin-api`.

## 6. Conditions (why PASS WITH CONDITIONS)
1. **ADR-024 acceptance.** Item #1 is decided (decorator-free framework, NestJS rejected); the exact HTTP library is a follow-up decision before the first served endpoint.
2. **Scoped security review of the custom WebAuthn CBOR decoder and passkey verification** (ADR-024 #2, hardened per R4) **before any real admin passkey is registered or used.** Not done; Gate 3 has used test authenticators only, and the code refuses passkey ceremonies outside `local` / `test` until the review outcome is recorded.
3. **AWS-dependent checks** (§5), recorded when AWS resumes (TE-02 removal condition, amended), including the shared atomic (Valkey) rate-limit store that deployed compositions now require.
4. **SR-02 browser-storage E2E** (no tokens in localStorage / sessionStorage / IndexedDB) and the cookie-flag check in a real browser run with the PWA (Gate 8); Gate 3 proves it at the API level (no token in any browser-surface response).
5. **R12 restriction:** session revocation is SECURITY_ADMIN only (decided, §3a). Widening it to SUPPORT_L2 / SAFETY_OFFICER needs city / region semantics for users first.
6. Gate 1 and Gate 2 conditions are unchanged, including TE-03: `two-reviewers-for-sensitive-paths` becomes a required check only with the final ruleset (owner action, §3a).

## 7. Decision
**PASS WITH CONDITIONS**. Every PR #6 check is green on GitHub (§2). Approver: founder (on merge of PR #6). Gate 4 not started.
