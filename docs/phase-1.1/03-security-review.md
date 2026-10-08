# Phase 1.1 · 03 — Pre-Implementation Security Review

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Scope: the Phase 1 design (docs 01–15) as amended by Phase 1.1. Objective: find design-level weaknesses **before** code exists. The stance is the same as before: minimise probability and blast radius, detect, revoke, recover, preserve evidence. Nothing is "unhackable".

---

## 1. Area-by-area verdict

| Area | Verdict | Notes / issue IDs |
|---|---|---|
| Authentication | ✅ Sound, with fixes | Realms separated. Agent web must move to the BFF cookie model (SR-02). Agents need phishing-resistant MFA for assist mode (SR-03) |
| Authorization | ✅ Sound | Policy layer + matrix tests. Add separation-of-duties rules (X-17) |
| BOLA/IDOR | ✅ Sound | Relationship predicates in SQL, 404s, generated matrix tests. Signed quote links need hardening (SR-05) |
| OTP | ✅ Sound | Limits, HMAC storage, breaker. Provider-side logging residual (SR-12) |
| SIM swap | ⚠️ Residual | Cooling-off + notifications cover payouts. Customer approvals after a SIM swap remain possible (SR-14) |
| Session management | ✅ with fixes | BFF session validation path (X-13). Client-IP trust chain (SR-10) |
| Device binding | ⚠️ | Shared phones / multiple technicians on one device not specified (SR-20). New-device hold vs earnings (X-32) |
| Admin security | ✅ Strong | IdP outage must not blind the safety desk (SR-17) |
| Field-agent privilege | ⚠️ Needs fixes | SR-02, SR-03, assist-mode spec ([01 §8](01-founder-decisions.md#8-d-18-assist-mode-specification)) |
| Technician payout changes | ✅ Strong | Cooling-off, penny-drop, multi-channel alerts, maker-checker for assisted changes |
| Payment webhooks | ✅ Strong | Signature + server fetch + amount check + dedupe |
| Telephony webhooks | ❌ **Unverified** | Indian telephony providers vary in request signing. Some rely on IP allowlists/URL secrets. **SR-01 is a blocker** until the telephony spike proves an authenticity mechanism |
| Quote approval | ✅ with fixes | Hash-bound, own channel. Ops-recorded channel disabled (SR-04). IVR approval by whoever answers (SR-21) |
| Address disclosure | ✅ with fix | L2 must also require customer verification (X-04) |
| File uploads | ✅ with fix | Decoder attack surface isolation (SR-09) |
| Call recordings | ⏸ Disabled | Pending D-15. Design ready |
| IVR PIN | ✅ with residual | Provider-side DTMF visibility (SR-12) |
| Start/completion codes | ✅ with residual | Coercion/forwarding policy (SR-13, X-34) |
| Rate limits | ✅ with fix | Client-IP trust through the BFF (SR-10) |
| CSRF | ✅ | SameSite + synchronizer token + Origin check. Agent web is covered once moved to cookies |
| CORS | ⚠️ Undefined | Deny-by-default policy to be added (SR-11) |
| SSRF | ✅ with fix | Egress allowlist. **PDF/HTML rendering path must not be a headless browser with network access** (SR-08) |
| XSS | ✅ | CSP/Trusted Types, text-only rendering. Admin is an isolated origin |
| SQL injection | ✅ | Query builder. Lint-ban `sql.raw`/string concatenation |
| Secrets | ✅ | Secrets Manager, OIDC, gitleaks. Mobile has publishable keys only |
| Logging | ✅ Strong | Allowlist logger + collector redaction + canary tests. Signed-link tokens in CDN/WAF logs (SR-05) |
| PII | ⚠️ | KMS blast radius (SR-06). Erasure gaps (SR-07). Manual pilot PII sprawl (SR-19) |
| Backups | ⚠️ | Erasure claims need correction (X-25/SR-07). Otherwise strong (vault lock, cross-region) |
| Database access | ✅ with fixes | Grant corrections (X-10/11/12). Ledger writes from the worker only (SR-18) |
| Cloud IAM | ✅ | Org SCPs, per-role task roles, JIT access |
| CI/CD | ⚠️ | Signature enforcement claim corrected (SR-16) |
| Third-party vendors | ⚠️ | Vendor security due diligence checklist missing (SR-23) |
| AI prompt injection | ✅ | Closed-enum outputs, no side-effect tools |
| AI data leakage | ⚠️ | Audio can't be redacted (SR-15). Keep AI voice features off until India-region/consented processing is confirmed |

---

## 2. High-risk and notable issues

### SR-01 Telephony webhook authenticity (IVR command injection): **Critical (blocker)**
- **Affected:** `webhook` → `voice` flow endpoints. Offer acceptance, arrival, completion, cash recording via IVR.
- **Exploit path:** An attacker learns the flow URL format (e.g., a former employee, or a leaked provider config) and POSTs forged "DTMF = 1" events with a guessed/observed call ID → accepts offers for a colluding technician, marks arrivals/completions, records cash.
- **Mitigation:** (1) The telephony spike must confirm the provider supports **request signing or mTLS**, or at minimum IP allowlisting + per-call secret URL tokens. (2) Each outbound call gets a **per-call nonce** embedded in its flow URL. Inbound calls get the nonce at the first step. (3) For state-changing nodes, **verify the call with the provider API** (call SID exists, is in progress, from/to numbers match the session) before committing (cache per call). (4) Presence actions additionally require customer codes (already). (5) Alert on flow requests for unknown or ended calls.
- **Test:** ST-24 extended: forged flow requests with valid-looking call IDs, replayed nonces, ended calls, wrong source IP → rejected and alerted.
- **Residual:** Low–Medium (depends on provider capabilities). **Choose providers by this criterion.**

### SR-02 Field-agent web uses bearer tokens in the browser: **High**
- **Affected:** agent web surface (05 §3.1 `aud=agent-web`).
- **Exploit path:** XSS or a malicious browser extension on an agent's (often personal, unmanaged) device reads the token → assist-mode L2 address access → address harvesting.
- **Mitigation:** BFF cookie sessions for agent web (X-14), short sessions, assist-mode L2 only with passkey step-up (SR-03), CSP.
- **Test:** No token in JS-accessible storage (automated check). CSP violation tests. Session cookie flags.
- **Residual:** Medium (agents' devices are unmanaged).

### SR-03 Phishable agent MFA + assist mode: **High**
- **Exploit path:** Phishing page captures the agent's OTP + TOTP → attacker requests assist mode via social engineering of ops → views addresses.
- **Mitigation:** Assist mode requires a **passkey** (phishing-resistant), the ops grant is bound to a specific visit and agent, the technician is notified by SMS, and grants are rate-limited per agent with anomaly alerts. TOTP-only agents can't hold assist mode.
- **Test:** Assist grant denied without a passkey assertion. Grant expiry. Notification sent.
- **Residual:** Low–Medium.

### SR-04 Ops-recorded approval (insider/collusion fabrication): **High**
- Covered in [01 §3](01-founder-decisions.md#3-d-11-threat-analysis-ops-recorded-customer-approval). **Disabled** by default. Separation of duties enforced in DB (X-17).
- **Test:** Recorder = capturer → rejected. Recorder = verifier → rejected. Approval without recording hash → rejected. Feature flag off → endpoint 404.
- **Residual:** Low while disabled. Medium if enabled.

### SR-05 Signed quote link token exposure: **High**
- **Affected:** `/v1/links/quotes/{token}`.
- **Exploit path:** The token in the URL path is captured by CDN/WAF/ALB access logs, browser history on shared phones, or **WhatsApp link-preview fetchers**. Anyone with the token sees the quote (minimal L0-like data) and can request an OTP (which goes to the registered number, so approval still needs the phone).
- **Mitigation:** Put the token in the **URL fragment** (`/q#t=…`). Fragments aren't sent to servers or logged. The page posts the token in the body. GET pages expose only non-sensitive content (no address, technician first name only). `Referrer-Policy: no-referrer`. A single-version token that expires with the version. Link-preview requests get a generic page.
- **Test:** CDN/WAF/app logs contain no tokens after E2E link flows (canary). Preview-bot user agents get generic content.
- **Residual:** Low.

### SR-06 PII decryption blast radius (single `pii-field` CMK): **High**
- **Exploit path:** RCE in `api` (or `voice`) → the task role can call KMS Decrypt on any subject DEK → bulk decrypt addresses/phones.
- **Mitigation:** (1) KMS **encryption context** = `{subject_id, data_class}` on every wrap/unwrap, logged in CloudTrail. (2) Per-role KMS key policies limited to the data classes each role needs (e.g., `voice` can only use addresses and phone context). (3) **Decrypt rate anomaly alarms** per role (CloudTrail → EventBridge → alert when the decrypt rate exceeds the baseline). (4) Short DEK cache TTL (≤ 5 min), bounded size. (5) Application-level guard: decryption only via the disclosure service, which checks relationship + window (no generic "decrypt" helper exported).
- **Test:** A role without the data-class grant fails to decrypt. Mass decrypt simulation triggers the alarm in staging.
- **Residual:** Medium. A determined attacker inside a role can still decrypt at the allowed rate. Detection and response are the control.

### SR-07 Erasure doesn't reach archives / provider events / some backups: **High (privacy/legal)**
- Detailed in X-25. **Mitigation:** key-subject mapping for every encrypted column, pseudonymous-only archives, minimised and short-lived provider payloads, an honest DSR residual statement, an erasure ledger re-applied after restores. ⚖️ Confirm acceptable backup residency for erased data.
- **Test:** The erasure E2E verifies no decryptable PII in DB, archives (sampled), S3 objects or AI logs. Restore drill re-applies erasures.
- **Residual:** Medium until legal confirms the backup position.

### SR-08 Invoice/evidence PDF rendering → SSRF/XSS: **High (if a headless browser is used)**
- **Exploit path:** A customer name/address containing HTML/JS is rendered by headless Chromium to PDF → fetches `http://169.254.169.254/` or internal URLs, or exfiltrates data.
- **Mitigation:** Generate PDFs with a **programmatic PDF library (no HTML engine)**, or run a sandboxed renderer with **no network** (separate task, no egress, no IMDS) and escape all fields. Fonts are bundled locally.
- **Test:** Injection payloads in names/addresses → inert in the PDF. The renderer task has no network (verified).
- **Residual:** Low.

### SR-09 Media decoder attack surface: **Medium-High**
- **Exploit path:** A malicious HEIC/JPEG/audio exploits a decoder vulnerability (libheif, libvips, ffmpeg) in the worker → RCE with the worker's privileges (the broadest DB role).
- **Mitigation:** Run decoding in a **separate, minimal-privilege scanner task** (its own ECS service, no DB access except updating `file_objects` via an internal API, no egress, read quarantine/write clean only), apply resource limits (pixel/duration caps, decompression-bomb limits), and patch decoder images weekly.
- **Test:** Fuzz corpus in CI for the decoder wrapper. Bomb files rejected. The scanner task's IAM can't reach other buckets.
- **Residual:** Low–Medium.

### SR-10 Client-IP trust through the BFF: **Medium**
- X-15. **Mitigation:** signed client-IP header over BFF↔api mTLS. Rate limits for web keyed on the session + IP from that header. **Test:** spoofed headers from non-BFF sources ignored.

### SR-11 CORS undefined: **Medium**
- X-16. **Mitigation:** no CORS on `api`/`admin-api`. **Test:** cross-origin preflight denied.

### SR-12 Provider-side visibility of DTMF (PIN, codes): **Medium**
- **Exploit path:** Telephony provider dashboards/logs store gathered digits → provider staff or a compromised provider console sees PINs and visit codes.
- **Mitigation:** Select providers that support masking/non-logging of gather input. Disable provider call-log retention where possible. Restrict provider console users (SSO+MFA). PINs only protect medium-value actions, and codes are single-use per visit. **Rotate PINs if a provider breach is notified.**
- **Residual:** Medium (vendor trust).

### SR-13 Start/completion code coercion and forwarding: **Medium**
- **Exploit path:** A technician pressures the customer to read the completion code before the work is done, or the code is forwarded to someone not at home.
- **Mitigation:** Customer copy: "Share the completion code only when the work is done and you're satisfied." Post-completion confirmation to the customer ("Was the work completed? 1 yes 2 no") with a 24 h dispute window. Adult-present policy (X-34).
- **Residual:** Medium (social).

### SR-14 SIM swap → customer account → approvals: **Medium**
- **Exploit path:** An attacker SIM-swaps the customer's number → approves an inflated quote (with a colluding technician).
- **Mitigation:** High-value approvals need step-up. Approval receipts go to the registered number *and* the WhatsApp of record. Approvals from a new device within 24 h of first login above the threshold → hold for a confirmation call. **Residual:** Low–Medium.

### SR-15 Voice notes/audio to external AI providers: **High (privacy)**
- Audio contains spoken names, addresses and phone numbers that **can't be redacted before transcription**.
- **Mitigation:** AI transcription stays **off** for the pilot unless the provider processes in India (or on our own infrastructure) under a DPA with no retention/training, and the customer consented to transcription specifically. Otherwise humans listen (restricted). ⚖️
- **Residual:** n/a while off.

### SR-16 Supply-chain enforcement claim: **Medium**
- X-26. IAM-restricted deploy path + pipeline signature verification + drift alerts.

### SR-17 Safety desk depends on the admin IdP: **High (safety)**
- X-19. **Mitigation:** SOS alerts are delivered out-of-band (telephony ring group + SMS with job ref/locality + a callback bridge number) independent of the console and IdP. A degraded-mode runbook. Monthly drill with the IdP "unavailable".
- **Test:** SOS drill with the admin console disabled → the desk receives and acts on the alert.

### SR-18 Ledger writes from multiple roles: **Medium**
- X-12. Only `app_worker` writes the ledger. Grants and tests enforce it.

### SR-19 Manual pilot PII sprawl (WhatsApp, spreadsheets, personal phones): **High (pilot)**
- **Exploit path:** Customer addresses/phones in ops staff's personal WhatsApp and widely shared spreadsheets. Lost phones, ex-staff access.
- **Mitigation:** Company-owned phones/WhatsApp Business accounts only. A single access-controlled workspace (company tenant, MFA, no external sharing, download/print disabled where possible). Masked number columns. A **data purge at pilot end** (or migration into the platform with consent). Pilot privacy notice + consent capture. Access list reviewed weekly. See [09 §7](09-manual-pilot.md).
- **Residual:** Medium (manual processes are inherently leakier). Time-box the pilot.

### SR-20 Shared devices: **Low–Medium**
- Multiple technicians (e.g., brothers) sharing one phone. **Mitigation:** allow at most 2 technician accounts per device, each with the app lock enforced, and flag for review. Purge local data per account on switch.

### SR-21 IVR approval by whoever answers the customer's phone: **Medium**
- ID check + amount limit (provisional ₹2,000, D-12) + approval receipt + dispute window. Validated in the field test.

### SR-22 Idempotency retention vs offline replay: **Low**
- X-20. 7-day keys for technician endpoints + state-idempotent actions.

### SR-23 Vendor security due diligence missing: **Medium**
- **Mitigation:** A vendor checklist before contracts: data location (India), DPA (DPDP processor terms), sub-processors, breach notification ≤ 24 h, deletion on request/termination, SSO+MFA consoles, audit reports (ISO 27001/SOC 2 where available), webhook signing (telephony!), log retention controls, pen-test summaries. Applies to the PA, telephony ×2, SMS ×2, WhatsApp BSP, KYC/BGV, maps, AI, error tracking.

---

## 3. Security blockers before Phase 2 (summary)

| Blocker | Must be resolved by |
|---|---|
| SR-01 Telephony webhook authenticity proven for the chosen providers | Telephony spike (before voice implementation) |
| SR-02/SR-03 Agent web session model + passkeys for assist mode | Spec update before the agent surface is built |
| SR-05 Fragment-based link tokens | Spec update before link approvals are built |
| SR-06 Per-role KMS data-class policies + encryption context | Spec update before the crypto library is built |
| SR-07 Key-subject mapping + archive policy | Spec update before migrations are written |
| SR-08 PDF generation approach | Before invoice/evidence generation |
| SR-17 SOS out-of-band alerting | Before any real SOS feature or pilot SOS promise |
| SR-19 Manual pilot data-handling SOP | Before the manual pilot starts |

All other items are tracked as standard work with tests in the Phase 2 backlog.
