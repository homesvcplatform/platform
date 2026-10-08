# Phase 1 · 12 — Threat Model

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Method: STRIDE per surface, mapped to OWASP ASVS 5.0 (L2 baseline, L3 for auth/admin/payments/PII), OWASP API Security Top 10 (2023), OWASP MASVS (technician app).
> **Security objective:** we do not claim the system "can't be hacked". We aim to **minimise attack probability and blast radius, prevent privilege escalation, isolate sensitive systems, detect compromise, revoke access quickly, recover safely, preserve evidence, and test continuously.** Every row below assumes the mitigation can fail and therefore lists detection and recovery.

STRIDE: **S**poofing · **T**ampering · **R**epudiation · **I**nformation disclosure · **D**enial of service · **E**levation of privilege.

---

## 0. Assets & attacker profiles

**Assets (by criticality):** customer addresses + phones · technician bank details/payouts · money flows/ledger · quote/price integrity · safety incident data · KYC documents · admin access · telephony (toll cost) · availability of booking/IVR/SOS · reputation data (ratings).

**Attackers:** A1 opportunistic external (bots, scrapers, credential stuffers) · A2 targeted external (fraud rings, SIM swappers) · A3 malicious customer · A4 malicious technician · A5 colluding customer+technician · A6 malicious field agent · A7 malicious/negligent employee · A8 compromised vendor (PA, telephony, SMS, AI, KYC) · A9 attacker with a stolen device/session · A10 stalker/abuser seeking a specific person's location.

---

## 1. Customer PWA

| ID | STRIDE | Attacker | Asset | Attack | Impact | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|---|---|
| PWA-1 | S | A2 | Customer account | OTP interception via SIM swap / social engineering | ATO: view addresses, approve quotes, cancel | Step-up for sensitive actions. No stored-value to steal. Addresses masked in lists. New-device notifications. Re-assigned-number soft gate | New device + unusual actions. Customer reports | Revoke sessions. Support recovery flow. Disputed approvals reviewed |
| PWA-2 | I | A3/A10 | Other customers' jobs | **BOLA:** iterate job/visit/quote IDs | Address/PII leak | Relationship predicates in SQL. 404 for foreign objects. UUIDv7 + authZ matrix tests | `authz_denied` spikes per user | Lock account. Investigate. Notify affected users if leaked |
| PWA-3 | T | A3 | Prices | Modify client to send a lower price/fee | Underpayment | Server-side pricing only. Clients send IDs/qty. `acceptedVisitFee` is only a confirmation | Mismatch → 409 counts | n/a (rejected) |
| PWA-4 | T/E | A1 | Session | XSS via problem text rendered in admin/PWA | Session theft, admin compromise | React escaping, no `dangerouslySetInnerHTML`, strict CSP + Trusted Types, HttpOnly cookies, text-only rendering | CSP violation reports | Revoke sessions. Patch. Audit reveal of affected data |
| PWA-5 | T | A1 | Actions | CSRF on cookie session | Unwanted cancel/approve | SameSite=Lax + synchronizer token + Origin check. Hash-bound approvals | Origin-check failures | — |
| PWA-6 | D | A1 | OTP/SMS budget | **SMS pumping** via OTP request | Cost, provider block | Per-phone/IP/device limits, +91 only, bot challenge, global breaker | OTP conversion drop | Auto-gate. Provider fraud claim |
| PWA-7 | I | A1 | Locality/slot data | Scraping serviceability/slots to map supply | Competitive/intel leak | Coarse availability, rate limits, WAF bot rules | Request patterns | Block. Tune rules |
| PWA-8 | R | A3 | Quote approval | "I never approved this" | Disputes, chargebacks | Approval row with channel evidence, content hash, session/device, timestamp. Customer notified on approval | — | Evidence pack for dispute/chargeback |

## 2. Technician Android app

| ID | STRIDE | Attacker | Asset | Attack | Impact | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|---|---|
| APP-1 | I | A4/A10 | Customer addresses | Hoard addresses (screenshots, API calls after the job) | Stalking, poaching | L2 window only. No address list endpoint. Local cache purge. Disclosure logging. Masked calls | Disclosure events per technician vs assignments | Sanction. Police escalation for stalking. Notify customer |
| APP-2 | T | A4 | Approved price | Modify app/API calls to change an approved quote or invoice | Overcharging | Immutable versions (trigger + grants). Server pricing. Invoice = approved (INV-09) | Rejected writes logged | n/a |
| APP-3 | S | A4 | Presence proof | **GPS spoofing** / mock location to fake arrival | False no-show claims, waiting fees | Start code is authoritative (GPS is never sole proof). Mock-location flag recorded. Waits need call evidence | Mock flags, impossible travel | Dispute reversal. Sanction |
| APP-4 | E | A9 | Session | Stolen/rooted device, token extraction | Account takeover → job theft, address access | Keystore storage, short JWT, device-bound RT, Play Integrity risk signal, optional app lock, remote session revoke | Integrity failures, new device | Revoke device. Payout hold |
| APP-5 | I | A1 | API surface | Reverse-engineer the APK to find hidden endpoints/secrets | Abuse of APIs | No secrets in APK. All endpoints authZ'd. Admin APIs on a separate host. R8 obfuscation (defense in depth only) | — | Rotate any accidentally shipped key (restricted keys only) |
| APP-6 | T | A4 | Diagnosis evidence | Reuse photos from other jobs/internet | Fake repairs | In-app camera only for diagnosis photos. pHash dedupe. Timestamps | pHash duplicates | Investigate. Sanction |
| APP-7 | D/I | A4 | Offline queue | Replay old offline actions to manipulate timestamps | False on-time metrics | Server timestamps authoritative. `client_reported_at` informational. Idempotency keys | Large client/server skew | — |

## 3. Basic-phone IVR

| ID | STRIDE | Attacker | Asset | Attack | Impact | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|---|---|
| IVR-1 | S | A2/A10 | Address, job actions | **Caller-ID spoofing** of a technician's number | Hear the address, mark arrival/complete | PIN for L2/actions. Customer codes for presence. Low-risk-only on caller ID | PIN failures. Calls while the real technician is on another call | Lock PIN. Callback to the real technician |
| IVR-2 | S | A2 | PIN | Brute-force PIN | As above | 3/call, 5/24 h lockout. Weak PIN rejection | Lockouts | Agent-verified reset |
| IVR-3 | I | Family member | Offer details / address | Someone else answers the phone | Minor (L0) / address exposure | ID check before details. Address only after the PIN | — | — |
| IVR-4 | D/$ | A1/A2 | Telephony budget | **Toll fraud:** trigger many outbound calls or long inbound | Cost | Outbound only to registered technicians/customers. Per-number caps. No user-controlled dialing. Missed-call callback rate limits | Cost anomalies | Breaker. Provider block |
| IVR-5 | T | A2 | IVR webhook | Forge provider webhooks to inject DTMF | Accept offers, mark completion | Signature + IP allowlist + per-call nonce. Internal mTLS to voice | Signature failures | Rotate secrets. Review actions |
| IVR-6 | R | A4 | Accept/complete | "I didn't accept that job" | Disputes | Per-node interaction log, call IDs, confirmation step | — | Evidence |
| IVR-7 | D | Provider outage | Offers, SOS | Provider down | Missed jobs; **SOS failure** | Secondary provider. Static SOS forwarding at the provider. Manual dispatch SOP | Circuit open | Fail over. Post-incident review |

## 4. Admin console

| ID | STRIDE | Attacker | Asset | Attack | Impact | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|---|---|
| ADM-1 | S/E | A2 | Admin accounts | Phishing for admin credentials | Full data access | SSO + **phishing-resistant MFA (passkeys)**, zero-trust proxy with device posture, no public endpoint | IdP risk signals, new device | Disable at IdP. Revoke sessions. Rotate. Audit review |
| ADM-2 | I | A7 | PII | **Insider snooping** (e.g., looking up an ex-partner) | Privacy harm, stalking | Masked by default. Reveal needs reason + ticket. City scope. Per-admin reveal limits. Audited | Reveal anomalies. Reveals without linked tickets | Disciplinary. Notify the data principal if required ⚖️ |
| ADM-3 | E | A7 | Permissions | Self-grant roles / modify role definitions | Escalation | Maker-checker (checker ≠ maker, ≠ grantee). Permissions defined in code | Grant change alerts | Revert. Investigate |
| ADM-4 | T | A7 | Money | Fraudulent refunds/payouts/write-offs | Theft | Thresholds + maker-checker. Payout to verified methods only. Cooling-off. Payload-hash binding | Refund velocity per admin. Approver-pair patterns | Claw back. Disciplinary/legal |
| ADM-5 | I | A7 | Bulk data | Export or scrape via admin UI | Mass breach | Exports disabled by default. Pseudonymised. Approved. Rate limits on list endpoints. Watermarking | Export logs. Volume anomalies | Revoke. Incident process |
| ADM-6 | T | A1 | Admin UI | Stored XSS from user-supplied text | Admin session takeover | CSP, escaping, isolated origin, short sessions, step-up for high-risk actions | CSP reports | Revoke. Patch |

## 5. Public APIs

| ID | API Top 10 | Attack | Mitigation | Detection |
|---|---|---|---|---|
| API-1 | API1 BOLA | ID iteration on jobs/visits/quotes/files/payment intents | Relationship predicates. 404. Matrix tests | Denial spikes |
| API-2 | API2 Broken auth | Token forgery, alg confusion, refresh replay | ES256 pinned, aud/iss checks, rotation with reuse detection | Reuse events |
| API-3 | API3 Property-level authZ | Mass assignment of status/price; excessive data in responses | Strict DTOs in and out per surface | Schema violation counts |
| API-4 | API4 Resource consumption | Large payloads, pagination abuse, upload floods | Body limits, limit ≤ 50, upload quotas, rate classes | 429 rates |
| API-5 | API5 Function-level authZ | Calling admin functions from the public API | Admin on a separate host/realm. Policy per endpoint (default deny) | — |
| API-6 | API6 Sensitive business flows | Mass booking/cancellation to block supply. Coupon abuse. Rating farming | Per-customer velocity limits, phone verification, no referral incentives in V1 | Velocity alerts |
| API-7 | API7 SSRF | URL fields | No server-side fetch of user URLs. Egress allowlist proxy. IMDSv2 | Egress denials |
| API-8 | API8 Misconfiguration | Verbose errors, CORS `*`, debug endpoints | Problem+json without internals, strict CORS, no debug in prod (startup assertion) | Config scanning |
| API-9 | API9 Inventory | Forgotten old versions/endpoints | OpenAPI is the source of truth. Route registry diffed in CI. Deprecation policy | Unknown route hits |
| API-10 | API10 Unsafe consumption | Trusting provider responses | Validate provider payloads with schemas. Re-fetch before money changes. Timeouts | Validation failures |

## 6. Webhooks

| ID | STRIDE | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|
| WH-1 | S/T | **Webhook forgery** ("payment captured") | HMAC verification on the raw body, timestamp window, dedupe, **server-side fetch before posting**, amount match | Signature failures | Reverse via compensating entries. Rotate secret |
| WH-2 | R | Replayed old events | `(provider, event_id)` uniqueness. State-machine guards | Duplicate counts | — |
| WH-3 | D | Flood | Lightweight verify-and-store path. Separate service. WAF rate rules per provider IP | Queue depth | Scale out. Block non-provider IPs |
| WH-4 | I | Payload contains PII stored in plain | `payload_enc`. Partitioned retention | — | — |

## 7. Database

| ID | STRIDE | Attacker | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|---|
| DB-1 | T/I | A1 | SQL injection | Parameterised builder. Lint against raw concatenation. Least-privilege roles | WAF + DB error patterns | Patch. Assess via pgaudit |
| DB-2 | I | A7/A8 | Stolen DB snapshot/backup | Encryption at rest (KMS). App-level field encryption of PII. Cross-account backup vault with restricted restore. Crypto-shredding | KMS decrypt anomalies. Snapshot share events (CloudTrail) | Rotate keys. Incident notifications ⚖️ |
| DB-3 | T | A7 | Direct edits to ledger/quotes | No standing human write access. Append-only grants + triggers. Hash-chained audit. JIT break-glass with pgaudit | pgaudit alerts. Ledger invariant checks | Compensating entries. Investigation |
| DB-4 | E | A1 via compromised `api` task | Use DB creds beyond the API's needs | Per-process DB roles (ADR-019). Network SG per role | Unusual queries per role | Rotate creds. Redeploy |
| DB-5 | D | A1 | Expensive queries / lock contention | Statement/lock timeouts, pool limits, load shedding | Slow query alerts | Kill sessions. Index fixes |

## 8. Object storage

| ID | STRIDE | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|
| S3-1 | I | Public bucket misconfiguration | Account-level Block Public Access, SCP denying public ACL/policies, AWS Config rules | Config non-compliance alert | Immediate block. Access log review |
| S3-2 | T | **Malware/polyglot upload** to attack admin viewers or vendors | Quarantine → magic-byte → AV → re-encode. No SVG/HTML. Rasterised PDFs | Rejection rates | Purge. Rescan |
| S3-3 | I | Signed URL leakage/sharing | ≤ 5 min TTL, per-object, authZ before signing, no listing, KYC download disabled | — | — |
| S3-4 | I | EXIF location leakage | Strip all metadata on re-encode (tested) | Canary test | — |

## 9. Payment system

| ID | Attacker | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|---|
| PAY-1 | A2/A9 | **Payout redirection** (ATO → change bank → payout) | Step-up, penny-drop name match, 72 h cooling-off (payouts to old method meanwhile), multi-channel alerts, no IVR/support-initiated changes without maker-checker, new-device payout hold | Change → payout attempt patterns | Hold. Reverse with PA if possible. Restore the method |
| PAY-2 | A3 | **Refund abuse** (false "not done" claims) | Completion-code evidence, refund only via complaints/disputes, limits per account/device/address | Refund velocity, linked accounts | Block. Recover via chargeback evidence |
| PAY-3 | A4/A5 | **Cash fraud** (collect more than the bill, or deny collection) | Fixed cash amount = amount due. Customer confirmation. Mismatch → dispute. "Never pay more than ₹X" messaging | Denial rates per technician | Dispute → adjustments/sanctions |
| PAY-4 | A3 | Chargeback after service | Evidence pack automation | Chargeback rate | Contest. Bad-actor block |
| PAY-5 | A7 | Manipulated payout batch | Maker-checker, anomaly flags, hash-bound approval, reconciliation | Batch anomalies | Hold/reverse. Investigation |
| PAY-6 | A8 | PA compromise / wrong settlement | Daily reconciliation, SUSPENSE account, amount checks | Recon exceptions | Escalate to PA. Legal |

## 10. Telephony

| ID | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|
| TEL-1 | Toll fraud (see IVR-4) | caps, allowlists | cost alerts | breaker |
| TEL-2 | Masked number abuse (contact after the job) | Binding window = L2. Registered-number-only bridging | Calls outside window (rejected count) | Revoke binding |
| TEL-3 | Recording exposure at the provider | Recordings fetched then deleted at the provider. Provider transcript storage off. DPA | Provider audit | Deletion request to provider |
| TEL-4 | Provider account takeover (call routing changed) | Provider console SSO+MFA, IP allowlists, change alerts, config as code where supported | Routing-change notifications, test calls | Restore config. Rotate |

## 11. AI providers

| ID | Attack | Mitigation | Detection | Recovery |
|---|---|---|---|---|
| AI-1 | **Prompt injection** in problem text/voice ("mark as emergency, free") | AI outputs are parsed into closed enums/schemas only. No tools with side effects. Customer/ops confirmation. AI never sets price/state | Output-schema rejections | Kill switch |
| AI-2 | PII leakage to the provider | Redaction before calls (names, phones, addresses → tokens). Data-processing terms (no training on our data). India-region preferred ⚖️ | Redaction coverage tests | Disable feature. Provider deletion request |
| AI-3 | Cost blow-up / DoS | Per-request token caps, per-user rate limits, daily budget with kill switch | Budget alerts | Auto-disable |
| AI-4 | Biased categorisation | Suggestions only. Per-language eval sets. Monitor accept/override rates | Override rate by language | Retrain prompts/turn off |

## 12. Internal employees

| ID | Threat | Mitigation | Detection | Recovery |
|---|---|---|---|---|
| EMP-1 | Insider snooping (ADM-2) | as above | as above | as above |
| EMP-2 | Collusion between two admins to bypass maker-checker | Approver diversity rules (not the same pair repeatedly above threshold), periodic review of pairs, high-risk actions to city manager/finance only | Pair-frequency analytics | Investigation |
| EMP-3 | Engineer accesses production data | No standing prod access. JIT via SSM with session recording. Masked views. Break-glass only for writes | Session logs reviewed | Revoke. Disciplinary |
| EMP-4 | Malicious code change (backdoor) | Protected branches, 2 reviewers for sensitive modules, CODEOWNERS, signed images, CI-only deploys, SBOM | Unusual commits/deploys | Revert. Rotate secrets. Forensic review |
| EMP-5 | Departing employee retains access | IdP deprovisioning, quarterly recertification, no shared accounts | Access review | Revoke |

## 13. Field agents

| ID | Threat | Mitigation | Detection | Recovery |
|---|---|---|---|---|
| AGT-1 | **Fake technicians / ghost onboarding** for incentives | Agents can't verify. Independent verification officer. Technician consent from the technician's own phone. Incentives tied to sustained verified activity | Low activation, duplicate docs/devices/bank accounts across an agent's technicians | Claw back incentives. Terminate agent |
| AGT-2 | **Identity swap** (verified technician sends someone else) | Customer sees photo + "Is this the person?" check. Start code. Spot-check selfie (app) | Customer reports | Sanction. Re-verify |
| AGT-3 | Agent harvesting customer data | Agents get no L2 by default. Assist mode is time-boxed and logged | Disclosure events by agents | Revoke. Legal |
| AGT-4 | Agent takes bribes to steer jobs | Agents can't assign or influence matching | — | — |
| AGT-5 | Agent changes a technician's payout account | Agent-initiated changes need maker-checker by finance + technician confirmation by IVR from the registered phone + cooling-off | Pattern alerts | Revert. Terminate |

---

## 14. Cross-reference: priority threats

| Threat | Primary IDs |
|---|---|
| BOLA/IDOR | PWA-2, API-1, APP-1 |
| Account takeover | PWA-1, APP-4, ADM-1 |
| SIM swap | PWA-1, PAY-1 |
| OTP abuse | PWA-6, API-6 |
| Payout redirection | PAY-1, AGT-5 |
| Admin compromise | ADM-1, ADM-3, ADM-6 |
| Insider snooping | ADM-2, EMP-1, EMP-3 |
| Fake technicians | AGT-1 |
| Identity swaps | AGT-2 |
| Quote tampering | PWA-3, APP-2, DB-3 |
| Cash fraud | PAY-3 |
| Refund abuse | PAY-2 |
| Rating manipulation / collusion | 11 §9 signals, API-6, EMP-2 |
| Webhook forgery | WH-1, IVR-5 |
| SSRF | API-7 |
| File malware | S3-2 |
| Prompt injection | AI-1 |
| Telephony fraud | IVR-4, TEL-1, TEL-4 |
| API scraping | PWA-7, API-4, API-9 |
| GPS spoofing | APP-3 |

---

## 15. Assumed-breach scenarios (tabletop before launch)

1. **An `api` task is compromised (RCE).** Blast radius: `app_api` DB grants (no ledger writes, no admin tables), no KMS decrypt for KYC/recordings, egress allowlist. Response: isolate the task definition, rotate DB creds and provider keys, review pgaudit/CloudTrail, forensic image, notify per ⚖️ timelines.
2. **A support admin's laptop is compromised.** Passkeys resist credential phishing, but session hijack is possible. Device posture and short sessions limit it. Reveal limits cap the exposure. Response: revoke at IdP, list reveals by that admin in the window, notify affected users if needed.
3. **SMS provider breach** (OTP logs exposed). OTPs are short-lived. Detect logins in the window, force re-auth of sessions created during it, and switch provider.
4. **Telephony account takeover** re-routes the SOS number. Provider change alerts + the hourly synthetic SOS test call → page. Use the backup SOS mobile numbers published on ID cards.
5. **Ledger tampering suspicion.** Hash-chain verification + reconciliation + immutable archives → identify the window, rebuild balances from verified entries, use compensating entries.

Evidence preservation: CloudTrail and log-archive in a separate account with Object Lock. DB snapshots retained during investigations. Chain of custody documented in the IR runbook.
