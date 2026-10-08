# Phase 0 · Part 3 — Security & Privacy Architecture (Sections 10–11)

> Status: **DRAFT for review** · Date: 2026-10-08
> Reference frameworks: OWASP ASVS 5.0 (target **Level 2** for all surfaces, **Level 3** controls for admin, payments, PII and auth), OWASP Top 10, OWASP API Security Top 10, OWASP MASVS (technician app), NIST SSDF-style secure SDLC.
> Legal anchors (to be confirmed with Indian counsel): **Digital Personal Data Protection Act 2023 + DPDP Rules 2025** (phased commencement), **IT Act 2000** and the **CERT-In Directions (April 2022)**, **RBI** payment-aggregator and data-storage directions (handled mainly through our PA), **TRAI TCCCPR** (DLT for SMS/voice), **Aadhaar Act** restrictions, the **Consumer Protection (E-Commerce) Rules 2020**, the **Code on Social Security 2020** (platform-worker provisions), and state platform-worker laws (e.g., Rajasthan, Karnataka).

---

## 10. Security architecture

### 10.1 Threat model summary (STRIDE, top items)

| Asset | Main threats | Primary controls |
|---|---|---|
| Customer address and phone | Insider snooping, technician over-access, scraping, BOLA | Stage-gated reveal, masked calling, field encryption, PII-reveal audit, per-object authZ |
| Technician bank details | Account takeover → payout redirection | Cooling-off, penny-drop name match, change alerts, maker-checker, no IVR changes |
| Quotes / prices | Silent price change, collusion, tampering | Immutable versions, content hash in approval, DB triggers, invoice = approved quote |
| Money flows | Webhook spoofing, double refunds, payout fraud | Signature verification, idempotency, reconciliation, ledger invariants, approval thresholds |
| Admin console | Phishing, session hijack, privilege abuse | SSO + phishing-resistant MFA, zero-trust proxy, scoped RBAC, maker-checker, break-glass |
| OTP/auth | SMS pumping, brute force, SIM swap | Rate limits, attempt caps, integrity checks, device binding, step-up for sensitive actions |
| Telephony | Caller-ID spoofing, toll fraud, IVR brute force | Outbound-initiated trust, PIN for sensitive actions, call-rate limits, number allowlists |
| AI pipelines | Prompt injection, PII leakage, cost blow-up | Output-constrained tasks, redaction, no side-effect tools, budgets |
| Uploaded files | Malware, EXIF location leakage, oversized files | Quarantine pipeline, scan, re-encode, strip metadata, signed URLs |

### 10.2 Authentication

| Population | Mechanism |
|---|---|
| **Customers (PWA)** | Phone + OTP (SMS; WhatsApp OTP as an alternate channel). Web session uses a **BFF pattern**: the server holds tokens, and the browser gets an `HttpOnly; Secure; SameSite=Lax` session cookie (`__Host-` prefix). No tokens in JS-accessible storage. Session idle timeout 30 days (rolling, configurable). Re-auth (fresh OTP) for sensitive actions: change phone, delete account, data export, add payout/refund destination. |
| **Technicians (app)** | Phone + OTP (Android **SMS Retriever API**, so no SMS-read permission) → **access token** (JWT, ES256, 10 min TTL, audience-scoped) plus a **refresh token** (opaque, 256-bit random, stored as SHA-256 hash, device-bound, rotated on every use, **reuse detection revokes the whole family**). The refresh token lives in Android Keystore-backed secure storage. Optional app lock (PIN/biometric) because shared phones are common. **Play Integrity** attestation at login and on sensitive calls (soft-fail plus risk score, not a hard block, so older devices still work). |
| **Basic-phone technicians (IVR)** | Trust is layered: (1) **we initiated the call** to the registered number (strongest); (2) inbound **caller ID** matches the registered number (spoofable, so only enough for low-risk actions: status, availability); (3) a **4-digit IVR PIN** (Argon2id; 5 attempts, then lockout and agent callback) for job actions such as arrival or completion, combined with the **customer's start/completion code**, which proves physical presence. **Never allowed via IVR:** payout method changes, phone number changes, viewing past addresses. |
| **Field agents** | Phone + OTP plus a **mandatory second factor** (TOTP app or passkey on their smartphone). Scoped to their linked technicians. Short sessions (12 h). |
| **Admins** | **Separate identity realm.** Company SSO (Google Workspace / Microsoft Entra) through a zero-trust proxy. **Phishing-resistant MFA (passkeys/FIDO2 keys) mandatory.** Session max 10 h, idle 30 min. Step-up re-auth for high-risk actions. No shared accounts. Joiner-mover-leaver process tied to HR. Quarterly access reviews. |
| **Service-to-service / CI** | IAM roles (no static keys). GitHub OIDC → short-lived AWS credentials. DB credentials are IAM-auth or rotated by Secrets Manager. |

**JWT/session strategy, specifically:**
- Asymmetric signing (ES256). Private key in KMS (sign via KMS or a short-lived in-memory key fetched at boot and rotated). JWKS endpoint with `kid` rotation.
- Claims are minimal: `sub` (user id), `aud`, `iat`, `exp`, `sid` (session id), `roles` (coarse), `dev` (device id). **No PII in tokens.**
- Short TTL means revocation happens mostly through refresh denial. A Redis **session denylist** keyed by `sid` gives immediate kill (suspension, compromise) and is checked on each request (cheap).
- `alg` is pinned server-side. `none`/HS confusion is rejected. `aud`/`iss` are validated. Clock skew ≤ 60 s.

**Password hashing:** no end-user passwords exist. If any local secret exists (IVR PIN, app PIN on the server side, break-glass account), it uses **Argon2id** (m≥64 MB, t≥3, p=1; tuned to ~250 ms) with a per-hash salt.

### 10.3 OTP security

| Control | Value (configurable) |
|---|---|
| Code | 6 digits, CSPRNG, **stored as HMAC hash**, single use |
| Expiry | 5 minutes |
| Verify attempts | 5 per challenge, then the challenge is invalidated |
| Send limits | 1 per 30 s per phone; 5 per hour per phone; 10 per day per phone; per-IP and per-device-fingerprint limits; **global circuit breaker** on anomalous send volume |
| SMS pumping/toll fraud | Only **+91** mobile ranges. Velocity anomaly detection. Bot checks on the web (Cloudflare Turnstile/invisible challenge on suspicious traffic). Play Integrity on the app. Alerts on cost spikes. |
| Enumeration | Same response whether or not the number is registered |
| Logging | OTP values are **never** logged, traced, sent to error trackers or included in analytics. SMS provider logs are configured to mask where supported. |
| SIM-swap risk | New-device login on an account with payout methods triggers step-up (agent verification call or IVR PIN) and a **payout hold** for the cooling period |
| Delivery | DLT-registered template. Domain-bound WebOTP format for PWA autofill (`@housefi.in #123456`). Fallback to WhatsApp OTP or a voice OTP call. |

### 10.4 Authorization

**Model: RBAC for coarse capabilities + ABAC/relationship checks for every object access**, implemented in one **policy layer** (e.g., a `can(actor, action, resource)` function per module with exhaustive tests). Each endpoint declares its policy. A lint/test fails the build if an endpoint has none (default-deny).

| Actor | Can access |
|---|---|
| Customer | Own profile, own addresses, own jobs (and their diagnosis/quotes/invoices), the technician's **public** profile for their active/past jobs |
| Technician | Own profile, earnings and offers. A job **only while assigned** (active window: assignment → closure + 24 h). Customer data reduced to the reveal matrix in 11.3 |
| Field agent | Linked technicians' onboarding and status data, and actions *on behalf of* them (logged with both identities). **No customer data** except the job info the technician would see, and only when the agent is explicitly assisting that job |
| Admin roles | Per permission **and** per scope (city/zone). See [04 §14](04-ux-admin-voice-matching.md#14-admin-architecture) |

**BOLA defence (OWASP API #1):** every repository method that fetches by ID takes the actor and applies scope predicates in the query (`WHERE id = $1 AND customer_user_id = $actor`). An automated **authorization matrix test** calls every endpoint with every role against foreign objects and expects 404/403.

### 10.5 API protection

| Threat | Control |
|---|---|
| Abuse / scraping / brute force | WAF managed rules plus custom rules. **Rate limits** (token bucket in Redis) per IP, per user, per device and per endpoint class (auth, booking, search, uploads). Stricter limits on unauthenticated endpoints. Response-size caps. Pagination max 50. |
| Mass assignment | Explicit Zod DTOs per endpoint. Unknown fields are rejected (`strict()`). Server-controlled fields (status, price, technician_id) are never accepted from clients. |
| Injection (SQL) | Parameterised queries only through the query builder. Raw SQL is allowed only in reviewed migration/repository files with a lint check against string concatenation. The DB role has least privilege (no DDL at runtime). |
| XSS | React auto-escaping. **No `dangerouslySetInnerHTML`** (lint-banned). Strict **CSP** with nonces, `object-src 'none'`, `base-uri 'none'`, Trusted Types where supported. User text rendered as text only. Output encoding in SMS/WhatsApp templates (no user-controlled URLs). |
| CSRF | Cookie-authenticated web uses SameSite=Lax plus a **double-submit/synchronizer token** on state-changing requests, plus Origin/Referer checks. Bearer-token APIs (app) aren't CSRF-prone, but the CORS allowlist is strict. |
| SSRF | The server **never fetches user-supplied URLs**. Outbound HTTP goes through an **egress allowlist** (VPC egress proxy / security groups to known provider domains). IMDSv2 enforced. Webhook targets are configuration-only. |
| Deserialization / uploads | JSON only, body size limits (e.g., 100 KB for APIs). File uploads use a separate pipeline (10.6). |
| Security misconfiguration | Hardened headers (HSTS, X-Content-Type-Options, Referrer-Policy `strict-origin-when-cross-origin`, Permissions-Policy limiting mic/camera/geolocation to `self` where needed, frame-ancestors `'none'`). No stack traces to clients. Generic error codes plus a `request_id`. |
| Business-logic abuse | State-machine guards on server. Server-side price computation only. Velocity checks (bookings per customer per hour, cancellations, coupon use). |
| Webhooks | HMAC/signature verification, timestamp tolerance, replay protection via event-ID uniqueness, provider IP allowlist where published. |

### 10.6 Secure file uploads

1. The client requests an upload slot (type and size declared) → the server returns a **presigned PUT** to the **quarantine bucket**, scoped to one key, ≤ 5 min expiry, content-length range enforced.
2. An S3 event triggers the scan worker: **magic-byte type check** (allowlist: JPEG/PNG/WebP/HEIC → re-encoded to WebP/JPEG; PDF for documents; audio AAC/OPUS/AMR for voice notes) → **malware scan** (GuardDuty Malware Protection for S3 or ClamAV) → **image re-encode**, which strips EXIF including GPS → resize variants.
3. Clean objects move to the **clean bucket** (separate KMS keys for KYC vs general). Rejected files are deleted and the attempt is logged.
4. Files are served only via **short-lived signed URLs** (≤ 5 min) after an authZ check. Never public. `Content-Disposition: attachment` for documents.
5. KYC documents have the strictest access (verification role only) and lifecycle deletion.

### 10.7 Secrets management

- All secrets live in **AWS Secrets Manager**, injected at runtime through task IAM roles. Never in env files committed to git, never in container images, **never in frontend or mobile bundles**.
- Mobile/PWA contain only **public, restricted identifiers** (e.g., a Maps SDK key restricted by Android package + SHA-256 signing cert / HTTP referrer, and the FCM sender config). Sensitive third-party calls are proxied through the backend.
- **gitleaks** runs in pre-commit and CI (blocking). GitHub secret scanning and push protection are on.
- Rotation: DB credentials automatic. Provider API keys every 90 days or on staff exit. Rotation runbook per provider.
- Separate secrets per environment. Production secrets are not readable by developers (break-glass only).

### 10.8 Encryption & key management
See [02 §9.8](02-architecture-stack-data.md#98-encryption-requirements). In addition:
- KMS key policies separate **administrators** (manage keys) from **users** (encrypt/decrypt). No single human holds both for production.
- KMS decrypt for KYC keys is limited to the verification worker role, and the decrypt rate is monitored.
- The backup encryption key is in a separate account (backup vault) to resist ransomware or account compromise.

### 10.9 Admin security (defense in depth)

1. **Network:** the admin API/console is not on the public load balancer. It is reachable only through the zero-trust proxy (identity + device posture).
2. **Identity:** SSO + phishing-resistant MFA. Per-person accounts. Automated deprovisioning.
3. **Authorization:** least-privilege roles, **city-scoped**. Time-bound elevated grants (JIT access with expiry). Quarterly recertification.
4. **PII by default masked:** phone and address are masked in lists. "Reveal" needs a reason code (and a ticket ID), is audited and rate-limited per admin, and anomalous reveal volume alerts the security lead.
5. **Maker-checker** for pricing/commission changes, refunds above threshold, manual payouts, payout-method overrides, technician deactivation, role grants, bulk exports and warranty-policy changes.
6. **Bulk export** is disabled by default. Exports are pseudonymised, watermarked, approved and logged.
7. **Session security:** short sessions, step-up for sensitive actions, single active session per admin (configurable).
8. **Break-glass:** sealed super-admin credentials (2 people, hardware keys). Use triggers an immediate alert and post-incident review.

### 10.10 Database access controls

- Roles: `app_<module>` (DML on its own schema only; INSERT-only on append-only tables), `migrator` (DDL, CI-only), `readonly_ops` (PII-masked views), `analytics_etl` (replica, PII-stripped views), `break_glass`.
- No human has standing production DB write access. Read access is through masked views, JIT and logged (`pgaudit` enabled for DDL, role changes and break-glass sessions).
- DB is in private subnets. No public endpoint. Access via SSM Session Manager bastion with session recording.
- **Row-Level Security** is optional for defense-in-depth on the most sensitive tables (`addresses`, `safety_incidents`). Evaluate in Phase 2 (app-layer authZ stays primary).

### 10.11 Backup security

- Automated snapshots plus PITR (35 days). **Cross-region copy** to ap-south-2. **Cross-account backup vault** with vault lock (immutable) for ransomware resilience.
- Backups are encrypted with a dedicated KMS key. Restore permissions are separate from backup permissions.
- **Monthly restore drill** into an isolated account, with documented RTO/RPO results. Restored data never flows to lower environments.
- Crypto-shredded subjects stay unreadable after restore. The erasure ledger is re-applied after any restore.

### 10.12 Logging, monitoring & detection

- **Structured JSON logs** with an **allowlist logger**: only declared, safe fields are emitted. Phone → `phone_hash`/last-2. Address never logged. Request/response bodies not logged by default. OTP/PIN/token fields are automatically redacted (and unit-tested).
- **Security events** go to a dedicated stream: auth failures, OTP velocity, token reuse, authZ denials, admin PII reveals, config changes, webhook signature failures, unusual payout changes, Play Integrity failures.
- Detection rules (initial): OTP send spikes; single IP touching many accounts; technician accessing many job IDs; admin reveal spikes; refund velocity; payout-method change followed by payout within N days; repeated failed IVR PINs; cancelled-after-quote patterns.
- Cloud: CloudTrail (all regions, org trail, immutable), GuardDuty, Security Hub, AWS Config conformance packs.
- **CERT-In compliance:** synchronise clocks to NTP (NIC/NPL or Amazon Time Sync, which is traceable); keep logs **in India for a rolling 180 days**; **report cyber incidents within 6 hours** of noticing them; designate a CERT-In point of contact.

### 10.13 Incident response

- **Severity levels:** SEV1 (data breach, payment compromise, safety-critical outage) → SEV4.
- **Runbooks:** suspected data breach, admin account compromise, payout fraud, OTP/SMS pumping attack, telephony toll fraud, mass technician account takeover, ransomware, third-party (PA/telephony) breach.
- **Regulatory clocks:** CERT-In (6 h). **DPDP Rules 2025:** intimate the Data Protection Board and affected Data Principals without delay, with the detailed report to the Board within **72 hours** (confirm the final rule text and commencement date with counsel). The PA/RBI path applies to payment incidents.
- Roles: incident commander, comms lead, legal/DPO, engineering lead. Pre-drafted notices in Hindi/English/regional language.
- **Tabletop exercise** before launch and twice a year after.

### 10.14 Secure SDLC

- Threat modelling for each phase (part of the "review after each phase" gate).
- PR requirements: 1+ reviewer (2 for `auth`, `payments`, `pricing`, `backoffice`, `compliance`), CODEOWNERS, passing SAST/SCA/secrets/tests, migration review.
- Dependency hygiene: lockfiles, pinned versions, `npm ci`, provenance checks, Renovate with grouped updates, no install scripts by default (`ignore-scripts` plus an allowlist). SBOM generated per build.
- Signed container images. Deploy only images built by CI (admission check).
- Mobile: MASVS L1 + selected L2 controls (secure storage, no sensitive data in logs or backups, `android:allowBackup=false`, debuggable off, R8 obfuscation, root/integrity signals as risk input).
- **External penetration test before pilot launch**, then annually and after major changes. Bug bounty / responsible-disclosure page from launch (`security.txt`).

---

## 11. Privacy architecture

### 11.1 Roles under DPDP

- Housefi is the **Data Fiduciary** for customers, technicians, agents and staff.
- Vendors (telephony, SMS, PA, KYC/BGV, cloud, AI, maps) are **Data Processors** under written contracts: purpose limitation, security obligations, breach notification, deletion on termination, and sub-processor lists.
- Appoint a **Grievance Officer / DPO contact** (publish contact details). Grievance response within the period prescribed by the Rules (currently 90 days; target ≤ 7 days).
- **Children:** the service is for **18+ account holders only** (self-declaration plus terms). We do not knowingly process children's data. If a minor is the person at home, no data about them is collected.
- Likely not a **Significant Data Fiduciary** initially. Architect for SDF obligations anyway (DPIA, periodic audit) because the Care Visit and women-safety features raise sensitivity.

### 11.2 Data classification

| Class | Examples | Who can see | Storage |
|---|---|---|---|
| **Public** | Technician display name (first name + initial), photo (with consent), verification badges, aggregate rating, languages, areas served (locality level), jobs completed (bucketed) | Anyone viewing a technician card in a job context | Plain |
| **Internal / Operational** | Job category, status, timestamps, zone/locality, quote line items, technician metrics | Parties to the job (scoped), ops roles | Plain, access-controlled |
| **Confidential** | Phone numbers, exact address, customer name, payment metadata, call metadata, complaints | Need-to-know, stage-gated, masked by default for admins | Field-encrypted, audited reveal |
| **Restricted** | ID documents, BGV results, bank/UPI details, gender, safety incidents, call recordings, investigation notes | Specific roles only (verification, finance, safety), with JIT access | Separate KMS keys, strictest retention, every access logged |

### 11.3 Stage-gated disclosure matrix (minimum necessary)

| Data | Technician before accept | After accept → closure (+24 h) | After that |
|---|---|---|---|
| Customer name | — | First name only | — |
| Customer phone | — | **Masked virtual number** (bridge valid only during job window) | Binding expires |
| Address | Locality + approx. distance | Full address + landmark + pin | Locality only in history |
| Problem description | Category + symptom + short summary | Full description, photos, voice note | Summary only |
| Customer history | — | **Only** notes relevant to this job (e.g., "dog at home", access instructions) and the warranty link if this is a warranty job | — |
| Customer's rating of others / complaints | Never | Never | Never |

| Data | Customer sees about technician |
|---|---|
| Always | Display name, photo, badges (identity verified / BGV / skill verified), rating (Bayesian, threshold-gated), jobs completed bucket, languages |
| During job | Masked call; ETA (if the technician shared it); start code to give |
| Never | Phone, legal name, address, ID documents, other customers' details, sanction history |

### 11.4 Consent design

- **Notice first, in plain language,** available in English and the user's chosen language (DPDP allows English or any Eighth-Schedule language; we support the pilot languages at minimum). The notice is short and layered, with a link to the full privacy policy.
- **Purpose-specific consent** recorded in `consent_events` with notice version, language, channel and proof (OTP id / IVR recording reference / app tap with device id).

| Purpose | Basis | Default |
|---|---|---|
| Service delivery (booking, matching, contact through masked number) | Consent at signup (and/or legitimate use for the specified purpose as defined in DPDP s.7(a); legal to confirm) | Required for the service |
| Call recording (support/IVR) | Separate consent; announced at call start | Opt-in; service works without it (except safety lines, where the announcement and legal basis are reviewed) |
| One-time location sharing | Just-in-time permission prompt | Off |
| Marketing (WhatsApp/SMS promos) | Separate opt-in | **Off** |
| Gender (for women-customer stats / women-worker preference) | Separate opt-in with explanation | Off |
| BGV for technicians | Explicit consent naming the vendor and checks performed | Required for verification level |
| Benefits enrolment (future) | Consent per partner program | Off |

- **Withdrawal is as easy as granting** (same screen; IVR option 7 for basic-phone technicians; agent-assisted). Withdrawal stops processing for that purpose. We tell the user the consequences in plain words.
- **Consent Manager** integration (DPDP-registered consent managers): architect `ConsentPort` so a registered consent manager can be plugged in later.
- **Basic-phone technicians:** consent is captured by IVR in their language ("Press 1 to agree") plus an SMS copy of the notice. The agent can explain but **cannot consent on their behalf**.

### 11.5 Data-subject rights workflow

`data_rights_requests` with SLA timers:
- **Access:** machine-generated summary of personal data and processing purposes, plus the list of processors by category. Delivered in-app/by link after OTP re-verification.
- **Correction/updating:** self-service for most fields. Verified fields (legal name, bank) go through the verification desk.
- **Erasure:** see 11.6.
- **Grievance:** tracked ticket, escalation path, and Data Protection Board contact information in the response.
- **Nomination:** record a nominee for exercising rights on death/incapacity (DPDP right).
- Every request and action is audited.

### 11.6 Deletion / erasure mechanics

1. Verify identity (OTP) → check blockers (open job, open dispute, outstanding dues, legal hold). If blocked, explain and schedule.
2. **Erase:** profile PII, addresses, voice notes, photos not needed for legal records, consents (keeping the proof record), devices, sessions, marketing data.
3. **Retain (minimised and pseudonymised):** invoices and ledger (tax/accounting law), job records needed for warranty/disputes until expiry, safety incidents (legal), audit logs. These keep the `user_id` tombstone but not the decryptable PII.
4. **Crypto-shred** the subject key. PII in backups becomes unreadable.
5. Propagate to processors (deletion API calls or tickets): SMS/WhatsApp BSP, telephony recordings, AI logs, analytics (pseudonymous ID unlinked).
6. Confirm to the user with a statement of what was retained, why, and until when.

### 11.7 Privacy by design in product decisions

- No continuous technician tracking. Arrival is verified by **start code**, not GPS.
- Masked calling only. No real numbers exchanged through the platform.
- Technician SMS for basic phones contains the address (needed operationally). We tell the technician it should not be shared, include no customer surname, and expire the masked number after the job. This **residual risk is documented and accepted**; the alternative (address only read out on the call) is offered to customers who choose "extra privacy" (Q22).
- AI calls receive **redacted** text (phone numbers, names, addresses replaced with tokens) whenever the task doesn't need them.
- Analytics never receives raw PII. Ratings from women customers are only shown as threshold-gated aggregates.
- Privacy impact assessment (**DPIA**) per feature that touches Restricted data. Mandatory before Care Visit.

### 11.8 Cross-border transfer

DPDP permits transfers except to countries the government restricts. Our posture: **primary processing and storage in India**. For any vendor processing outside India (e.g., some AI or error-tracking services), send only minimised/redacted data, record it in the processor register, and keep a migration path to India-region providers.
