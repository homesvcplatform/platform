# Phase 1: Detailed System Architecture (Overview)

> **Status:** APPROVED with errata (2026-10-08). The approved errata are in [docs/phase-1.1/FINAL-ERRATA.md](../phase-1.1/FINAL-ERRATA.md), which **governs where it differs from this document set**. Contract-level fixes (DDL, TCP list, grants, API, matching filters, IVR rules) are applied inline and tagged with their errata ID. · **No application code has been written.**
> **Source of truth:** Phase 0 (`docs/phase-0/`) as amended by the founder's Phase 1 brief. Where Phase 1 changes or sharpens a Phase 0 statement, it is listed explicitly in §6. Nothing has been changed silently.
> **Naming:** "Housefi" (and "GharSaathi") are working names. All user-facing brand elements are configuration ([ADR-016](15-architecture-decisions.md#adr-016-configurable-brand-identity)).
> **Legend:** ⚖️ = requires Indian legal/CA advice. No legal certainty is claimed anywhere in these documents.

---

## 1. Architecture summary

- **One modular monolith** (TypeScript/NestJS) running as **seven process roles**: `web-bff`, `api`, `admin-api`, `webhook`, `voice`, `worker`, `scheduler`. **21 bounded modules**, each with its own Postgres schema, public facade and domain events. Boundaries are enforced in CI (import rules, query-schema fitness tests, an explicit list of 3 transactional coupling points: TCP-1/2/3).
- **PostgreSQL 17 + PostGIS** is the system of record, including the **transactional outbox, job queue and durable timers** (Graphile Worker + a 1-minute sweeper). **Valkey** holds only ephemeral state.
- **Fulfilment model:** `Job` → **`Visit`** (first-class physical trip with its own state machine, assignment, presence codes and disclosure window) → **`Assignment`**. Approved quotes become **`RepairOrder`s** performed by one or more repair visits, or attached to the diagnosis visit for a guarded same-visit repair. A different technician and skill per visit is the normal case.
- **Quotes** are immutable versions, server-priced with stored price snapshots. Customer approval binds to a **content hash** through the customer's own channel. The invoice can never exceed the approved total + policy fees.
- **Three technician channels:** Android app (React Native, device-gated), **basic-phone IVR** (DTMF-first, PIN-gated, customer-held start/completion codes as presence proof), and **field-agent assistance** (scoped, audited, never verifying or assigning).
- **Stage-gated disclosure:** exact address and contact only inside a per-visit window. **Never by SMS.** Every access is logged.
- **Matching per visit:** 17 hard filters, explainable weighted scoring, **exclusive offers** (no tap races), channel-appropriate windows, rank-ordered waves, fairness accounting and IVR/app parity monitoring.
- **Money:** a regulated PA, integer paise, an **append-only double-entry ledger** with compensating corrections, daily reconciliation, maker-checker payouts and refunds. **No wallets.**
- **Security:** separate admin realm (SSO + passkeys + zero-trust proxy), per-process DB roles, field-level envelope encryption with crypto-shredding, allowlist logging, threat model across 13 surfaces, assume-breach operations.
- **AWS Mumbai** (Hyderabad DR), ECS Fargate, RDS Multi-AZ, IaC, signed images, the same digest promoted dev → test → staging → prod.

---

## 2. Document index

| # | Document | Contents |
|---|---|---|
| 01 | [Architecture](01-architecture.md) | Topology, process roles, trust boundaries, 21 module specs (responsibility, entities, interface, commands, events, read models, deps, prohibited deps), sync/async, outbox, timers, TCPs, provider-outage behaviour, scaling |
| 02 | [Domain model](02-domain-model.md) | Ubiquitous language, aggregates, the AC example end-to-end plus a refrigerator (non-AC appliance) example, repair performer choice, disclosure levels, segment ratings, **invariants INV-01…28** |
| 03 | [Database](03-database.md) | Conventions, ER diagrams, DDL-level schema for core tables, roles/grants/RLS, UUIDs, time, soft delete, immutability, locking, transactions, migrations, partitioning, retention |
| 04 | [API contracts](04-api-contracts.md) | V1 REST contracts for every listed area, with actor, auth, authZ, schemas, validation, errors, idempotency, rate class, audit. Admin and webhooks |
| 05 | [Auth & authorization](05-auth-authorization.md) | Realms, per-actor authentication, tokens and rotation, OTP, MFA, device binding, RBAC/ABAC/object-level, escalation protection, recovery, suspension, break-glass, **authorization matrix** |
| 06 | [Job workflows](06-job-workflows.md) | State machines for Job, Visit, Assignment, Offer, Diagnosis, Quote, RepairOrder, Payment, Dispute, Warranty, with actors, transitions, forbidden moves, timeouts, recovery, audit. Cancellation/no-show matrix |
| 07 | [Matching](07-matching.md) | Triggers, hard filters, scoring, exclusive offers, waves, direct offers, **fairness and IVR/app parity**, explainability, config and simulation |
| 08 | [Voice/IVR](08-voice-ivr.md) | IVR state machines (offer, hotline, check-in, approval, SOS, masked bridge), PIN, fallbacks, SMS content policy, recording policy, data minimisation |
| 09 | [Payments & ledger](09-payments-ledger.md) | Legal models A/B ⚖️, chart of accounts, postings for every flow, schema, provider rules, ledger invariants, reconciliation, payouts |
| 10 | [Files & data](10-files-and-data.md) | Buckets, upload pipeline, file kinds, **sensitive data register** (purpose · access · retention · deletion) |
| 11 | [Observability](11-observability.md) | Telemetry pipeline, never-log list, metrics, tracing, **SLOs & error budgets**, alerts, dashboards, audit logs, detection |
| 12 | [Threat model](12-threat-model.md) | STRIDE across 13 surfaces with attacker/asset/attack/impact/mitigation/detection/recovery, priority cross-reference, assumed-breach tabletop scenarios |
| 13 | [Testing strategy](13-testing-strategy.md) | Pyramid, suites and gates, invariant tests, authorization-matrix generation, 32 security test cases, telephony/device/offline/accessibility |
| 14 | [Deployment](14-deployment.md) | Environments, AWS org/topology, keys, secrets, IAM, CI/CD, rollback, migrations, security ops, backups/PITR/DR, incident response, cost |
| 15 | [ADRs](15-architecture-decisions.md) | ADR-001…020 (ADR-020: catalog scope revision) |

---

## 3. Key decisions (kept from Phase 0 or made in Phase 1)

| # | Decision | Where |
|---|---|---|
| K1 | Modular monolith, seven process roles, CI-enforced boundaries | ADR-001, 01 |
| K2 | PostgreSQL/PostGIS system of record. Postgres-backed queue/outbox/timers | ADR-002, ADR-015 |
| K3 | Customer PWA. Technician RN app with a device gate. Basic-phone IVR | ADR-003/004/005 |
| K4 | **Visits as first-class entities.** RepairOrder from approved quotes | ADR-006, 02, 06 |
| K5 | Immutable, hash-approved quote versions | ADR-007 |
| K6 | Double-entry ledger. No wallet | ADR-008, ADR-011 |
| K7 | Stage-gated disclosure (L0–L3). No address by SMS | ADR-009 |
| K8 | Customer-held start/completion codes as presence proof. No continuous GPS | ADR-012, ADR-017 |
| K9 | Exclusive offers and rank-ordered waves for IVR/app fairness | 07 |
| K10 | AI assistive only | ADR-010 |
| K11 | Separate admin realm. Maker-checker. Per-process DB roles | ADR-013, ADR-019 |
| K12 | Brand-neutral identifiers everywhere | ADR-016 |

---

## 4. Unresolved blockers (carried from Phase 0; still unanswered)

| Ref | Blocker | Blocks |
|---|---|---|
| Q1/Q2 | **Pilot city and launch languages** | Locality data, IVR prompt recordings, UI strings, telephony numbers |
| Q3–Q5 | **Legal model, invoice issuer, GST/TDS** ⚖️ | Payments beyond sandbox, invoices, tax lines, ledger account naming (D-08) |
| Q6/Q9 | **Visit fee, commission, diagnosis payout, payout frequency** | Pricing config, technician earnings messaging, D-06/D-07 |
| Q8 | **Cash at launch** + negative-balance cap | Ledger cash flows, D-13 |
| Q11 | **Minimum verification before first job** | Onboarding flow, matching H8 |
| Q13 | **Support and safety desk hours and staffing** | **SOS promises** (we must not promise a 2-minute callback we can't staff), IVR agent escalation |
| Q20 | **Team, budget, timeline** | Roadmap, Phase 2 start |
| New | PA selection + **money-flow model A/B** ⚖️ | Payments module |
| New | Telephony provider contract, number series (TRAI) ⚖️, DLT registration lead time | Voice module, SMS |

---

## 5. Decisions requiring founder approval

| ID | Decision | Recommendation |
|---|---|---|
| **D-01** | Address disclosure window for technicians | L2 opens at `max(acceptance, window_start − 3 h)`, closes at `visit end + 60 min`. Tighter than Phase 0's "closure + 24 h" |
| **D-02** | IVR PIN for basic-phone technicians before address playback and job actions | Yes (4 digits, set by the technician on an IVR call) |
| **D-03** | Double-press confirmation for IVR offer acceptance | On by default. Can be relaxed per technician after 20 successful IVR jobs |
| **D-04** | Customer's repair performer choice | Offer *Same visit now* (when eligible) / *Same technician later* / *Recommended specialist*, with `allow_fallback` defaulting to **true** |
| **D-05** | Billing timing when the repair is a separate visit | **One final bill** after the repair. A visit-fee-only bill only if the quote is rejected/expires or the repair is cancelled |
| **D-06** | Diagnosis payout when the same technician also repairs | Configurable `FULL` / `PARTIAL` / `NONE`. Recommend **PARTIAL** pending the unit-economics model |
| **D-07** | **Visit-fee credit economics:** crediting the full visit fee while paying a separate diagnosis technician can make a job loss-making (worked example in [09 §4.1](09-payments-ledger.md#41-worked-example-separate-diagnosis-and-repair-visits-illustrative-numbers-all-configurable): −₹58) | Choose one: partial credit, a minimum repair labour floor, or an explicit subsidy budget. The pricing simulator will enforce a margin warning |
| **D-08** | Money-flow model A (PA split to technician linked accounts) vs **B (platform collects, pays out)** ⚖️ | B if counsel confirms (better for low-documentation technicians), A as fallback |
| **D-09** | Women-customer rating | Build the data model and consent in V1. **Display off** until a DPIA and enough data exist. Women-only matching not in V1 |
| **D-10** | Brand-neutral Android `applicationId` and DLT header | Choose a neutral identifier now (it's irreversible on Play) |
| **D-11** | Allow the ops-recorded-call approval channel (customers who can't use links/IVR) | Allow ≤ ₹2,000 with a recorded call and a second ops verifier |
| **D-12** | Customer IVR approval amount limit | ₹2,000. Above that, link + OTP |
| **D-13** | Cash at launch, technician negative-balance cap | Allow cash, cap ₹1,500 (config), then online-only jobs until settled |
| **D-14** | Technician cancellation/no-show compensation even if the customer never pays | Yes (dignity). The platform bears the bad debt |
| **D-15** | Call recording policy ([08 §12](08-voice-ivr.md#12-call-recording-policy-legal-confirmation-required)) ⚖️ | As proposed: no recording of machine IVR or masked calls. Consented recording of support/diagnosis desk. SOS recorded subject to legal basis |
| **D-16** | IVR quiet hours | No offer calls 9 PM–7 AM unless the technician opts in |
| **D-17** | Add a separate **Test** environment + pilot infrastructure budget (~USD 1.0–2.5k/month excluding usage fees) | Approve |
| **D-18** | Field-agent "assist mode" (time-boxed L2 access granted by ops for a specific visit) | Allow in V1, ops-granted, ≤ 2 h, logged |

---

## 6. Phase 0 contradictions & changes (explicitly reported)

| ID | Phase 0 statement | Why it matters | Resolution in Phase 1 |
|---|---|---|---|
| **C-01** | 01-product §6.0/§6.5: the job state machine contains `REPAIR_SCHEDULED`/`IN_REPAIR`, and "same-visit repair is the default" (also 05 §24.2 assumption 8) | Contradicts the founder's requirement that diagnosis and repair visits be separate first-class entities. Second visits would have been an edge case | Job/Visit/Assignment/RepairOrder model (ADR-006). Neither path is "default". **Service rules + customer choice** decide. Phase 0 §6.0 is superseded by [06](06-job-workflows.md) |
| **C-02** | 01-product §6.4 (J4) and 03-security-privacy §11.7: the SMS to basic-phone technicians "carries … address", and residual risk was accepted (Q22) | Directly contradicts the founder's address-privacy change | SMS contains no address/contact. Address by IVR playback after PIN inside the L2 window (ADR-009, [08 §10](08-voice-ivr.md#10-sms-to-basic-phone-technicians-content-policy)). Q22 is resolved |
| **C-03** | 03-security-privacy §11.3: full address visible "after accept → closure (+24 h)" | Longer than necessary. Scheduled visits days ahead would expose addresses early | L2 window (D-01) |
| **C-04** | 02-architecture §7.1 rule 1: module isolation "enforced by DB grants per module role" | Impractical with pooled connections. Would create a false sense of isolation | Per-process-role grants + code-level fitness tests (ADR-019) |
| **C-05** | Brand hard-coded in examples: IVR "Housefi se bol rahe hain", OTP domain `@housefi.in`, DLT headers | Founder: brand is temporary. Some identifiers are irreversible (Play package, DLT) | Brand config + separate IVR brand clip + neutral identifiers (ADR-016, D-10) |
| **C-06** | 02-architecture §9.2: `jobs.ivr_code` per job | With multiple visits/technicians, the IVR reference must be per visit | `visits.visit_code` + context-based visit selection (most calls need no code) |
| **C-07** | 04 §16.4: waves where "first accept wins" | Favours faster phones/networks, against the founder's fairness requirement | Exclusive offers by default. Waves use **rank-ordered acceptance** at window close ([07 §6.3](07-matching.md#63-waves-only-under-sla-pressure)) |
| **C-08** | 05-delivery §21.1: environments local/dev/staging/prod | The founder requires Development → Test → Staging → Production | Added `test` environment (D-17) |
| **C-09** | 05-delivery §22: Phase 2 = "Database schema", Phase 3 = "API contracts" | Phase 1 now delivers both designs, so the numbering no longer matches the work | Proposed renumbering: **Phase 2 = Foundation + Thin Vertical Slice (implementation)**. Later phases keep their content and become hardening/broadening phases (§11) |
| **C-10** | 02-architecture §8: queue "Graphile Worker or pg-boss" | Open choice | Graphile Worker (ADR-015) |
| **C-11** | 01-product §6.5 example shows "visit fee adjusted" without technician-payout economics | With separate diagnosis and repair technicians, the platform may lose money per job | Surfaced as D-07. The pricing simulator shows margin per scenario |
| **C-12** | 02-architecture §9.2: `customer_profiles.gender_self_declared` column | A gender column next to profile data makes accidental exposure and use in matching easier | Separate restricted table, consent-gated, batch aggregates only (ADR-018) |
| **C-13** | 01-product §6.13: one customer rating per job | With two technicians per job, one rating can't be attributed fairly | One rating per **technician per job** (INV-16) |
| **C-14** | 01-product §6.4: IVR accept with a single keypress | Accidental accepts on button phones | Confirmation step (D-03) |
| **C-15** | 03-security-privacy §11.2 lists the technician's "areas served (locality level)" as public | Precise service-area lists for basic-phone technicians could reveal where a person lives/works | Keep the "areas served" trust signal, but only at **zone level** (e.g., "Serves Nashik West"), never as a locality list |

Phase 0 documents are **not edited** except for a pointer note in `docs/phase-0/README.md` to this section.

---

## 7. Assumptions

**Technical**
- T1. TypeScript team (ADR-014). AWS ap-south-1 with startup credits.
- T2. Pilot volume ≤ 200 jobs/day for 6 months. Peak design target 5× that.
- T3. At least two Indian telephony providers support dynamic IVR webhooks with < 2 s step timeouts, call bridging with virtual numbers, missed-call numbers and **static fallback routing** (to be verified in the telephony spike).
- T4. **Android 14+ restricts full-screen intent notifications** to calling/alarm apps (the user must grant permission otherwise), and OEM battery optimisations (common on budget devices) delay pushes. Offers therefore rely on high-priority notifications **plus IVR fallback** (`PUSH_THEN_IVR`), not on full-screen intents alone.
- T5. The PA offers UPI intent/collect, payment links, refunds, payouts with penny-drop, webhooks with signatures, and settlement reports via API.
- T6. A geocoding provider and curated locality data are good enough for zone/locality matching after concierge-pilot curation.

**Legal (⚖️ all require confirmation)**
- L1. The platform can operate as a marketplace/agent collecting on behalf of independent technicians through a PA (Model B), or must use split settlement (Model A).
- L2. GST e-commerce operator liability for notified services (s.9(5)), TCS (s.52), and TDS (s.194-O) apply as the CA determines. Tax lines stay inactive until then.
- L3. DPDP Act 2023 + DPDP Rules 2025 apply, with phased commencement. We design for full compliance at pilot launch regardless of the commencement date.
- L4. CERT-In Directions (2022): 6-hour incident reporting, 180-day log retention in India, NTP sync.
- L5. Code on Social Security 2020 platform-worker provisions and any state platform-worker law in the pilot state may require registration and contributions.
- L6. Consumer Protection (E-Commerce) Rules 2020 may require displaying seller (technician) information to consumers. **This conflicts with technician privacy minimisation** and needs a legal reading on what must be shown and how.
- L7. TRAI TCCCPR (as amended) numbering-series rules apply to service calls to technicians/customers. DLT registration is required for SMS.
- L8. Call recording requires notice/consent under DPDP. SOS recording needs a clear legal basis.
- L9. No Aadhaar numbers are collected. KYC goes via DigiLocker/licensed vendors.
- L10. Cancellation/no-show/waiting fees are permissible if disclosed upfront and fair.

**Security**
- S1. Credentials, devices, employee accounts and vendors **will** be compromised at some point. Designs assume breach.
- S2. The company IdP supports passkeys/FIDO2 enforcement. A zero-trust proxy is available.
- S3. Vendors sign DPAs with breach-notification and deletion clauses. Production data stays in India except redacted AI/error telemetry where approved (⚖️).
- S4. No production PII in non-production environments, ever.
- S5. An external penetration test is budgeted before the pilot.

---

## 8. Architecture approval checklist

| # | Item | Status |
|---|---|---|
| 1 | Modular monolith, process roles, topology | ✅ Ready |
| 2 | Module boundaries, dependency graph, TCP list | ✅ Ready |
| 3 | Domain model: Job / Visit / Assignment / RepairOrder | ✅ Ready (D-04, D-05 ⚠️ Needs founder decision) |
| 4 | Database schema (core tables, constraints, roles) | ✅ Ready |
| 5 | Data retention periods | ⚠️ Needs legal review |
| 6 | API contracts (V1) | ✅ Ready |
| 7 | Authentication & session design | ✅ Ready |
| 8 | Authorization matrix | ✅ Ready |
| 9 | Disclosure windows & IVR PIN | ⚠️ Needs founder decision (D-01, D-02) · ⚠️ Needs prototype testing (technician comprehension) |
| 10 | IVR flows and fallbacks | ⚠️ Needs prototype testing (telephony spike + ≥ 10 technicians) |
| 11 | Telephony provider selection | ⚠️ Needs prototype testing (commercial + latency) |
| 12 | Matching rules, fairness, parity | ⚠️ Needs prototype testing (simulation on concierge-pilot data) |
| 13 | Money-flow model (A/B) | ⚠️ Needs legal review (D-08) |
| 14 | Ledger design | ✅ Ready (account naming ⚠️ Needs legal review/CA) |
| 15 | Taxes & invoicing | ❌ Not ready (needs CA input: Q4/Q5) |
| 16 | Pricing economics (visit-fee credit, diagnosis payout) | ⚠️ Needs founder decision (D-06, D-07) |
| 17 | File pipeline & sensitive data register | ✅ Ready |
| 18 | Call recording policy | ⚠️ Needs legal review · ⚠️ Needs founder decision (D-15) |
| 19 | Observability, SLOs, never-log list | ✅ Ready |
| 20 | Threat model | ✅ Ready (tabletop exercise pending) |
| 21 | Testing strategy | ✅ Ready |
| 22 | Deployment, DR, CI/CD | ✅ Ready (budget ⚠️ Needs founder decision, D-17) |
| 23 | Technician app technology (RN vs Kotlin) | ⚠️ Needs prototype testing (device spike) |
| 24 | Brand-neutral identifiers | ⚠️ Needs founder decision (D-10) |
| 25 | Women-customer rating | ⚠️ Needs founder decision (D-09) · ⚠️ Needs legal review (DPIA) |
| 26 | E-commerce seller-information display vs technician privacy | ⚠️ Needs legal review (L6) |
| 27 | Benefits skeleton (no money flows) | ✅ Ready |
| 28 | Care Visit placeholders (disabled) | ✅ Ready |
| 29 | Pilot city & languages | ❌ Not ready (Q1/Q2) |
| 30 | Support & safety desk staffing (SOS SLAs) | ❌ Not ready (Q13) |
| 31 | Team, budget, timeline | ❌ Not ready (Q20) |

---

## 9. Top 10 architectural risks (ranked by severity)

| # | Risk | Why severe | Mitigation |
|---|---|---|---|
| 1 | **Telephony integration** (IVR latency, provider-specific flow capabilities, static fallbacks, number-series rules) | It's the core differentiator and the SOS path | Spike with 2 providers before Phase 2 voice work. `TelephonyPort`. Synthetic call monitoring. Static SOS fallback |
| 2 | **Money-flow legal model changes** after payments are built | Rework of PA integration and invoicing. Compliance exposure | Legal opinion before payments beyond sandbox. Ledger supports A and B |
| 3 | **Android delivery reliability** on budget devices (Android 14 full-screen-intent limits, OEM battery killers, Doze) | Missed offers hurt technician earnings and fill rate | `PUSH_THEN_IVR`, exclusive windows, device-lab tests, onboarding steps to whitelist the app (agent-assisted) |
| 4 | **State-machine complexity** (Job/Visit/RO/Quote/Payment interplay) | Edge-case bugs lead to wrong money or stuck jobs | Transition tables + DB transition triggers, property-based tests, sweeper, ops "stuck" dashboard |
| 5 | **Boundary erosion** in the monolith under deadline pressure | Big ball of mud. Blocks later extraction | Fitness tests are blocking. TCP allowlist. CODEOWNERS. Architecture review each phase |
| 6 | **Field-level encryption & crypto-shredding** complexity (KMS latency, key caching, rotation, no DB-side search) | Performance and correctness issues in PII paths | A single hardened crypto library in `platform`. Blind indexes. Load tests. Early implementation in the slice |
| 7 | **Postgres doing everything** (OLTP + queue + timers + outbox) | Contention at peaks | Monitoring, per-role pools, queue tuning, partitioning. Separate queue DB or SQS later if needed |
| 8 | **Locality/geo data quality** | Poor matching, travel estimates and serviceability | Concierge-pilot curation, ops tooling for aliases/adjacency, estimate-vs-actual metrics |
| 9 | **Low-end device performance** of the RN app | Technician exclusion | ADR-004 gate with a Kotlin fallback |
| 10 | **Untested DR / single-region dependency** | Long outage during a regional event | Monthly restore tests, semi-annual failover rehearsal, SOS independent of AWS |

## 10. Top 10 product risks (ranked by severity)

| # | Risk | Mitigation / validation |
|---|---|---|
| 1 | **Two-visit friction:** customers dislike waiting for a second visit and may abandon after diagnosis | Same-visit repair when eligible. Fast repair slots. Concierge pilot measures approval-to-repair drop-off |
| 2 | **Disintermediation is higher in the two-visit model:** the diagnosing technician knows the quote and can offer to do it privately, cheaper | Fair diagnosis payout, "same technician" option, warranty only on-platform, masked contacts and expiring windows, no address after the window, education. Track rejected-quote-then-no-rebook rates |
| 3 | **Unit economics** (visit-fee credit, telephony minutes, diagnosis desk time, PA fees) | D-06/D-07. Per-job cost metrics from day one. Pricing simulator |
| 4 | **Supply liquidity for specialists** (repair skills) per zone | Recruit by repair skill. Measure UNFULFILLED repair visits. Allow wider radius for repair visits |
| 5 | **IVR comprehension** (PIN, codes, menus) among basic-phone technicians | Field test (≥ 15 technicians, ≥ 90% task success). Native voice prompts. Agent training |
| 6 | **Ops diagnosis desk scales linearly** (every basic-phone diagnosis needs an agent) | Measure agent minutes/job. V1.1 keypad repair codes. Staffing model |
| 7 | **Safety desk promises vs staffing** | Q13 must be answered before committing SLAs. Honest copy ("we'll call back within X minutes during service hours. In danger, dial 112") |
| 8 | **Customer trust/understanding** of codes, masked numbers, approval links | Usability tests with low-literacy users. WhatsApp copy. Assisted phone channel |
| 9 | **Cash dependence** (leakage, negative balances, disputes) | Cash caps, UPI nudges, customer confirmations |
| 10 | **Regulatory costs** (social security contributions, GST liability) eroding margins | Early legal/CA input. Configurable fee/tax lines. Scenario modelling |

---

## 11. Phase 1 → Phase 2 gate

**Proposed renumbering (C-09):** Phase 2 = **Foundation + Thin Vertical Slice (first implementation)**. Phases 3–14 then broaden and harden: customer UX, technician UX, admin, full workflows, matching tuning, voice breadth, payments (live), warranty/support, testing/security audit, deployment/launch.

**Implementation may begin only when all of the following are true:**

*A. Approvals*
1. Founder has approved this Phase 1 package, ADR-001…020 (or recorded changes), and decisions D-01…D-18 (each either decided or explicitly deferred with the recommended default).
2. The Phase 1 review (architecture, security risks, UX problems, tech debt) has been held and its action items recorded.

*B. Blocking answers*
3. Q1/Q2 pilot city and languages decided.
4. Q13 support/safety desk hours and staffing decided (SOS copy and SLAs depend on it).
5. Q20 team, budget and target date confirmed. Minimum team in place: tech lead + 2 backend + 1 mobile + 1 QA (part-time DevOps).
6. Q6/Q8/Q9 provisional values set for the slice (sandbox money only).

*C. Legal (initiated, not necessarily concluded)*
7. Counsel and CA engaged, with written questions submitted on: money-flow model (D-08), GST/TDS/invoicing, DPDP notices/consents/retention, call recording, e-commerce seller-information rules, platform-worker law. **Live payments, invoices and recordings stay blocked until answers arrive. The slice uses PA sandbox + provisional invoice format.**

*D. Prototype evidence*
8. **Telephony spike passed:** dynamic IVR flow from AWS Mumbai with p95 step latency < 800 ms on two providers. Masked bridging works. Static SOS fallback works. Missed-call callback works.
9. **IVR paper/phone prototype** tested with ≥ 10 basic-phone technicians in the pilot region: offer comprehension, PIN entry, code entry. Outcomes recorded and the flows adjusted.
10. RN device spike **scheduled** for Phase 2 week 1 (must pass before technician-app feature work).

*E. Setup*
11. AWS Organization with dev/test/staging/prod + security/log-archive/backup accounts. GitHub org with branch protections and OIDC. IdP with passkeys enforced for admins.
12. Sandbox accounts: PA, telephony (×2), SMS. **DLT registration started** (neutral header) and a neutral domain registered.
13. CI template with SAST/SCA/secrets/IaC scanning and architecture fitness checks ready.

*F. Operations*
14. Concierge pilot running or scheduled, feeding repair catalog items, reference prices, locality aliases/adjacency and visit-fee acceptance data.

---

## 12. Thin vertical slice (first implementation after approval)

> **Superseded** by [docs/phase-2/05-first-slice-spec.md](../phase-2/05-first-slice-spec.md) (Scenarios 1 Plumbing, 2 Electrical with IVR simulator + ops desk, 3 Refrigerator not cooling, 4 AC regression). The text below is kept for history.

**Name:** *Slice 1: three categories end to end: plumbing, electrical and a non-AC appliance.* (Revised 2026-10-08, ADR-020. The original AC scenario is kept as a regression test.)

**Scenario A: Plumbing ("Kitchen sink leaking"), same visit + price change + cash.**
App technician diagnoses → same-visit repair eligible (service rule + `can_repair` + material carried) → the customer approves *Same technician now* → mid-repair a second fault → **Quote v2** → repair order CHANGE_PENDING → the customer approves v2 → completion code → the customer pays **cash**, the technician records it, the customer confirms via PWA → ledger cash-held netting → warranty coverage → rating.

**Scenario B: Electrical ("Frequent tripping in one room"), basic-phone technician + ops diagnosis desk + same technician later.**
**Basic-phone electrician** gets the IVR offer and accepts with confirmation → hears the address after the PIN inside the L2 window → arrives with the customer's start code via IVR → **diagnosis desk** call: the ops agent captures the diagnosis from the ELECTRICAL repair catalog (e.g., MCB replacement, part not carried) → quote presented on the **customer's** phone → the customer approves *Same technician later* → direct offer to the same technician → repair visit (material check by IVR) → completion code via IVR → the customer pays by **UPI (PA sandbox)** → warranty → rating.

**Scenario C: Appliance ("Refrigerator not cooling"), separate visits, different technicians and specialization.**
1. **Booking:** customer (PWA, Telugu/English) logs in by OTP, picks Appliances → Refrigerator → "Not cooling", adds an address with landmark, chooses ASAP, sees the visit fee, books (idempotent; a double tap creates one job).
2. **Matching:** the diagnosis visit is matched on `REFRIGERATOR` + `DIAGNOSE` with hard filters H1–H11 + simplified scoring → exclusive push offer to **Technician A (Android app)** → accepts (TCP-1).
3. **Travel & arrival:** A departs → L2 window opens (address + masked call visible, disclosure logged) → enters the customer's **start code**.
4. **Diagnosis & quote:** A records the diagnosis (gas leak/low refrigerant: `REP-FRIDGE-LEAK-FIX` + `REP-FRIDGE-GAS-CHARGE`, required specialization `GAS_REFRIGERATION`, which A doesn't hold) → server-priced **Quote v1** presented → A checks out. Diagnosis payout accrues (ledger).
5. **Approval:** the customer approves v1 in the PWA (hash-bound), choosing **Recommended specialist**, slot tomorrow 10–12.
6. **Repair order & repair visit:** RO created → repair visit V2 matched on `REFRIGERATOR` + `REPAIR` + `GAS_REFRIGERATION` → **Technician B (basic phone)** gets the **IVR offer call**, confirms identity, accepts with confirmation → SMS with no address.
7. **Repair:** B calls the hotline in the L2 window → PIN → hears the address → confirms materials → departs → arrives with the customer's **start code via IVR** → completes with the **completion code via IVR**.
8. **Payment:** the customer pays by UPI (PA **sandbox**) → webhook + server fetch → ledger postings → bill PAID → provisional invoice PDF.
9. **Close & warranty:** job CLOSED → **warranty coverage** per repair item from the policy snapshot.
10. **Ratings & earnings:** the customer rates A and B separately. A and B see statements (gross/commission/net) in the app / IVR earnings summary.

**Regression scenario (kept): "AC running but not cooling"**, two visits, two technicians (the original Phase 1 Scenario A, with the AC wiring diagnosis from [02 §3](02-domain-model.md)).

**Included platform foundations:** identity (OTP, sessions, refresh rotation, IVR PIN), policy layer + authorization-matrix tests for slice endpoints, audit log (hash-chained), outbox + Graphile Worker + sweeper, idempotency keys, field encryption library (addresses/phones) with blind indexes, disclosure service, file pipeline (diagnosis photos), allowlist logger + canary-PII test, OpenTelemetry basics, CI/CD to dev/test/staging, minimal admin (job timeline view, manual assign, presence override with maker-checker, **ops diagnosis-capture screen** for Scenario B), catalog seed data for the three categories and the enabled appliance service types.

**Explicitly excluded from Slice 1:** waves, reschedule, complaints/disputes UI (API stubs only), refunds and payout execution (statements only), WhatsApp (SMS only), AI suggestions, segment ratings, warranty claims (coverage creation only), multi-city, field-agent onboarding UI (seed data), live payments.

**Slice 1 acceptance criteria:**
- Scenarios A, B and C (plus the AC regression) pass as **automated E2E tests** in `test` (PWA via Playwright, app via Maestro, IVR via simulator) **and** once with real calls to test handsets in `staging`.
- Invariant tests green for INV-01, 03, 04, 05, 06, 07, 08, 09, 11, 14, 15, 17, 18, 21, 22, 23, 24, 28.
- Kill-the-worker test during the cascade: the offer expires and the next candidate is offered within SLA.
- Five rapid duplicate booking submissions → one job.
- Canary-PII scan: zero hits in logs/traces/errors.
- p95 latencies within SLO targets in staging under 5× pilot load for slice endpoints. IVR step p95 < 800 ms.
- Architecture fitness tests green (no cross-schema access outside TCP-1/TCP-2/TCP-3).
- Founder demo of Scenarios A, B and C, followed by the phase review (architecture, security, UX, tech debt) before Phase 3.

**Indicative effort:** ~10–12 weeks for a team of 5–6 engineers, including foundations (weeks 1–3: repo/CI/IaC/identity/platform kernel; weeks 3–7: jobs/visits/matching/diagnosis/quotes + PWA; weeks 5–9: voice + technician app; weeks 8–12: payments/ledger/warranty/ratings + hardening). To be re-estimated once Q20 is answered. The third scenario adds catalog/fixture work and test cases, not new modules.
