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
- After an erasure, another process may decrypt the subject's data for up to 5 minutes from its DEK cache (SR-06 bound). Tested.
- Identity users are created at OTP request (ADR-024 #6); never-verified rows need the retention job.
- The voice role has no DB grant on `identity.subject_keys`, so IVR can't reveal contact data yet (needed with the IVR gates; a grant migration then).

## 4. Tech debt register delta
| Item | Due |
|---|---|
| HTTP framework adapter (ADR-024 #1: NestJS needs a build step vs type stripping) | Founder decision before Gate 5/8 |
| Valkey rate-limit store; Valkey session denylist (DB check is the fallback today) | Deployment (TE-01) |
| Agent second-factor enrolment and completion (passkey / TOTP) | With the agent surface |
| Break-glass (05 §9), JIT elevation, PII-reveal workflow, access recertification | Their gates |
| Seed loader still uses the fixture crypto (ADR-023 #10 replacement) | When the seed CLI is composed with `kms-local` at app level |
| Idempotency-Key storage (no Gate 3 endpoint needs `required`) | First `required` business endpoint |
| Never-verified users purge | Retention job |

## 5. Not verifiable without AWS (TE-01 / TE-02)
Real KMS key policies per data class and per role (`kms-local` enforces the same grants in CI), Secrets Manager for peppers and signing keys, the asymmetric KMS signing key, BFF↔api mTLS, Valkey, CloudTrail decrypt-rate alarms (SR-06), the zero-trust proxy in front of `admin-api`.

## 6. Conditions (why PASS WITH CONDITIONS)
1. **ADR-024 acceptance**, including the **open item #1** (HTTP framework vs type stripping), decided before the first served endpoint.
2. **AWS-dependent checks** (§5), recorded when AWS resumes (TE-02 removal condition, amended).
3. **SR-02 browser-storage E2E** (no tokens in localStorage / sessionStorage / IndexedDB) and the cookie-flag check in a real browser run with the PWA (Gate 8); Gate 3 proves it at the API level (no token in any browser-surface response).
4. Gate 1 and Gate 2 conditions are unchanged.

## 7. Decision
**PASS WITH CONDITIONS**. Every PR #6 check is green on GitHub (§2). Approver: founder (on merge of PR #6). Gate 4 not started.
