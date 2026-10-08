# Phase 1.1: Decisions, Validation & Final Implementation Gate

> **Status:** APPROVED by founder (2026-10-08). Q-A/Q-B/Q-C answered. Corrections applied via [FINAL-ERRATA.md](FINAL-ERRATA.md). Safety specification in [SAFETY-OPERATIONS.md](SAFETY-OPERATIONS.md). Next: [docs/phase-2/](../phase-2/README.md) (plan awaiting approval) · **Date:** 2026-10-08
> **No application code, migrations, API implementations or UI screens have been written. No dependencies installed.** This phase resolves founder decisions, finds problems before implementation, and defines validation work and the final gate.
> **Phase 1 is unchanged.** Every proposed change to Phase 1 is listed in [02-contradictions](02-contradictions.md) or below, and is applied only after founder approval. ⚖️ = Indian legal/CA advice required.

## Document index

| # | Document | Purpose |
|---|---|---|
| 01 | [Founder decisions](01-founder-decisions.md) | D-01…D-18 register, primary workflow confirmation, D-11 threat analysis, D-13 cash design, D-14 evidence ladder, D-18 assist mode, Kurnool/Telugu pilot assumptions, localization architecture |
| 02 | [Contradictions](02-contradictions.md) | 35 cross-document contradictions in Phase 1 (12 high) with resolutions |
| 03 | [Security review](03-security-review.md) | Area-by-area verdicts + 23 issues (SR-01…SR-23) with exploit path, mitigation, test, residual |
| 04 | [Customer journey review](04-customer-journey-review.md) | 9 personas, friction, V1/V1.1/Later |
| 05 | [Technician journey review](05-technician-journey-review.md) | 9 personas across fairness, friction, privacy, earnings, safety, tech barriers |
| 06 | [Pricing & unit economics](06-pricing-and-unit-economics.md) | Simulator spec, 7 scenarios × 3 pricing models, blended unit economics, break-evens, sensitivities |
| 07 | [IVR field test](07-ivr-field-test.md) | ≥ 12 basic-phone technicians, 16 tasks, metrics, pass/fail thresholds |
| 08 | [Device test matrix](08-device-test-matrix.md) | 7 device classes, 16 measurements, ADR-004 decision rule |
| 09 | [Manual pilot](09-manual-pilot.md) | 12-week concierge pilot in Kurnool: process, money interim, data SOP, metrics, interviews, exit criteria |

## Headline findings

1. **Full visit-fee credit loses money on every repair path** with plausible Tier-2 numbers (Model A blended CM −₹31.8 per booked job). It would need ≈ ₹1,020 labour to break even when diagnosis and repair technicians differ. Models B (fixed inspection fee) and C (partial credit + platform fee) are positive at baseline, but **all models turn negative if the platform bears 18% GST on GST-inclusive prices** ⚖️. Tax treatment is a business-model blocker.
2. **Twelve high-severity contradictions** in Phase 1. The most consequential:
   - offers can expire mid-IVR-call (X-08, which hurts basic-phone technicians)
   - long direct offers block a technician's other jobs (X-06)
   - the bill must exist synchronously at completion, which needs a 3rd transactional coupling point (X-09)
   - addresses could be disclosed for unverified bookings (X-04)
   - the cash-cap rule couldn't be enforced as written (X-24)
   - erasure claims exceed what the design guarantees (X-25)
3. **Telephony webhook authenticity (SR-01) is unproven.** It's a blocker until the provider spike proves a mechanism, because forged IVR inputs could accept jobs or mark completions.
4. **The basic-phone diagnosis desk** is both the main cost driver and the main friction point. Keypad repair codes (V1.1) and pilot measurement are essential.
5. **Safety:** SOS must work without the admin console/IdP (SR-17). An adult must be present at visits (X-34). No numeric SOS promise until staffing is confirmed (X-33).

---

**Scope revision (2026-10-08):** the third top-level category is now **Appliance & Home Equipment**, with AC as one service type within it ([ADR-020](../phase-1/15-architecture-decisions.md#adr-020-appliance--home-equipment-replaces-standalone-ac)). This is a catalog/configuration change only. The thin slice now covers Plumbing, Electrical and "Refrigerator not cooling", with AC as a regression scenario.

---

## A. Founder decisions

| Status | Items |
|---|---|
| **APPROVED** | D-01 (stage-gated disclosure; + customer-verified condition) · D-02 (IVR PIN) · D-03 (double confirmation; no per-technician relaxation) · D-04 (three repair-performer options; clarification Q-A pending) · D-05 (final bill + separate visit-fee bills where appropriate) · D-06 (PARTIAL, provisional) · D-09 (data model + consent; display OFF; no gender in ranking) · D-10 (no final brand; names configurable) · D-13 (cash at launch, cap with transparent restriction) · D-14 (compensation in principle, evidence-gated) · D-16 (quiet hours 9 PM–7 AM) · D-17 (Test environment) · D-18 (assist mode with strict scope) · Pilot assumption: Kurnool, Telugu + English, 2–4 zones, 3 categories: Plumbing, Electrical, Appliance & Home Equipment (ADR-020; appliance service types for validation: Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler; all configurable) · Primary workflow: diagnosis visit → repair visit, same-visit as optimisation |
| **PENDING** | D-07 pricing model (needs pilot data; B and C to be tested) · D-08 payment-flow model ⚖️ · D-11 ops-recorded approval (built-but-disabled recommendation; needs D-15 + controls) · D-12 ₹2,000 IVR approval limit (prototype + legal) · D-15 call recording ⚖️ · Clarifications Q-A (specialist always offered?), Q-B (approve neutral technical identifiers now), Q-C (record language preferences in pilot) |
| **REJECTED** | Phase 1 recommendation for D-11 (ops-recorded approval as a normal channel ≤ ₹2,000) · ₹149 full-credit example as a final rule · Adding Hindi at launch · Relaxing IVR accept confirmation per technician |

## B. Legal / CA dependencies ⚖️

| # | Question | Blocks |
|---|---|---|
| L-1 | Money-flow model A vs B (platform collection as agent vs PA split) | Live payments, payouts (D-08) |
| L-2 | GST: e-commerce operator liability for these services, inclusive vs exclusive pricing, TCS, invoice issuer and format | Pricing model, invoices, CM (06 §2.1) |
| L-3 | TDS (s.194-O) on technician payouts | Payout statements |
| L-4 | Interim pilot money model (direct pay + commission remittance), receipts/invoicing | Manual pilot start |
| L-5 | DPDP: notices/consents (Telugu/English), retention schedule, erasure vs backups/archives (X-25) | Data model finalisation, DSR flows |
| L-6 | Call recording basis (support, diagnosis desk, SOS, ops-recorded approval) | D-15, D-11 |
| L-7 | CERT-In log retention/IP logs (X-23), incident reporting process | Logging config, IR runbook |
| L-8 | Consumer Protection (E-Commerce) Rules: seller (technician) information display vs privacy | Technician card content |
| L-9 | Code on Social Security platform-worker provisions; any Andhra Pradesh gig/platform worker law; establishment registration | Cost model, onboarding |
| L-10 | Police verification expectations for home-service workers in AP. BGV consent text | Onboarding/verification levels |
| L-11 | Cancellation/no-show/waiting fees fairness and disclosure. Damage liability terms | Pricing copy, ToS |
| L-12 | TRAI/DLT numbering and templates for service calls/SMS (with telephony provider) | Voice/SMS go-live |
| L-13 | AI processing location for audio/text (if ever enabled) | AI features (currently off) |

## C. Prototype dependencies

| # | Prototype | Decides | Doc |
|---|---|---|---|
| P-1 | **Telephony spike** on 2 providers: step latency, webhook authenticity (SR-01), DTMF masking (SR-12), masked bridge, static SOS fallback, missed-call callback, toll-free | Provider choice, voice design go-ahead | 03, 07 |
| P-2 | **IVR field test** R0–R2 with ≥ 12 technicians | IVR flows, D-03 prompts, ADR-005 scope | 07 |
| P-3 | Customer IVR mini-test | D-12 limit | 07 §9 |
| P-4 | **Device spike + matrix** | ADR-004 (RN vs Kotlin), OEM onboarding, PUSH_THEN_IVR defaults | 08 |
| P-5 | **Manual pilot** (12 weeks) | D-07 pricing, catalog/reference prices, locality data, ops staffing, two-visit viability | 09 |
| P-6 | Geocoding/locality accuracy test on real Kurnool addresses | Geo provider choice, locality curation | Phase 0 §8 |

## D. Security blockers (must be resolved in the spec before the related build)

SR-01 telephony webhook authenticity · SR-02 agent web on BFF cookie sessions · SR-03 passkeys for assist mode · SR-05 fragment-based link tokens · SR-06 per-role KMS data-class policies + encryption context · SR-07 key-subject mapping and archive policy (erasure) · SR-08 PDF generation without a networked HTML engine · SR-17 out-of-band SOS alerting · SR-19 manual-pilot data SOP (before the pilot).

## E. Product blockers

| # | Blocker |
|---|---|
| PB-1 | Support/safety desk hours and staffing (Q13) → SOS copy and SLAs |
| PB-2 | Adult-present policy and "who will be home" (X-34) |
| PB-3 | Cash design with `payment_preference` + H18 (X-24) |
| PB-4 | Evidence parity for IVR technicians in disputes/compensation (X-28, X-29) |
| PB-5 | Symptom-first booking + emergency same-visit service rules (C5-1, C6-1) |
| PB-6 | Telugu content: UI strings, IVR prompt recordings, templates. Native-speaker review |
| PB-7 | Damage complaint workflow + terms (C8) |

## F. Business-model blockers

| # | Blocker |
|---|---|
| BM-1 | Pricing model not chosen (D-07). Model A shown loss-making. B vs C needs pilot data |
| BM-2 | Tax treatment (L-2) can flip all models negative |
| BM-3 | Ops diagnosis-desk cost for basic-phone technicians unmeasured |
| BM-4 | Warranty revisit cost per item unknown (largest per-event loss) |
| BM-5 | Cancellation fee collectability and compensation exposure unknown |
| BM-6 | Social-security contribution exposure (L-9) |

## G. Architecture blockers (spec fixes needing founder sign-off)

| # | Item |
|---|---|
| G-1 | **Add TCP-3** (`jobs.completeVisit` → `payments.issueBill`, X-09). A change to the approved coupling list |
| G-2 | IVR offer hold during active calls (X-08) |
| G-3 | Offer concurrency rule by window/urgency (X-06) |
| G-4 | Disclosure L2 requires customer verification (X-04) |
| G-5 | Ledger writes only from the worker role. Grant corrections (X-10/11/12) |
| G-6 | BFF session validation via api. Client-IP trust chain. CORS deny-by-default (X-13/15/16) |
| G-7 | Erasure model: key-subject mapping, archives, provider events (X-25) |
| G-8 | Quote/bill line model alignment (`VISIT_FEE_CREDIT`, `PRIOR_PAYMENT_CREDIT`) (X-21/22) |
| G-9 | Separation of duties in approvals (X-17) |
| G-10 | Remaining medium/low contradictions applied as a **Phase 1 errata patch** (one reviewed change set to the Phase 1 docs) |

## H. Things that can safely be implemented now (after this document is approved)

These are independent of pending legal and pricing decisions, and are needed under any outcome:
1. Repository, CI pipeline, security scanning, architecture fitness tests, environments dev/test via IaC.
2. Platform kernel: IDs, money type, errors, clock, outbox + Graphile Worker + sweeper, idempotency, audit log (hash-chained), allowlist logger + canary-PII test, policy-engine skeleton, field-encryption library (with SR-06/SR-07 designs).
3. Identity: phone OTP (sandbox SMS), sessions, refresh rotation, BFF cookie model, step-up, admin SSO integration (test IdP).
4. Geo (cities/zones/localities/adjacency), catalog, config/brand profiles, **localization framework** (te-IN, en-IN; locale enablement gate).
5. Jobs/visits/assignments/repair orders **state machines** with persistence, timers and history. Disclosure service.
6. Diagnosis + quote versioning with a **pricing engine that reads configurable rules** (no final values; test fixtures only).
7. Matching core (hard filters, scoring, exclusive offers, explanations) against the simulator.
8. Ledger core (accounts/transactions/entries, invariants) used only with sandbox/test data.
9. File upload pipeline (quarantine/scan/re-encode in an isolated task).
10. IVR **flow engine + telephony simulator** (no production numbers).
11. Admin skeleton (SSO, RBAC, maker-checker framework, job timeline).
12. Test harnesses: authorization-matrix generator, property tests, E2E scaffolding.

## I. Things that must NOT be implemented yet

1. Live payment collection, payouts, refunds against real money, or any code path assuming Model A or B (D-08).
2. Tax computation, invoice numbering/format, GST lines (L-2/L-3).
3. Final pricing rules or hard-coded fee values (D-07).
4. Call recording capture/storage/playback (D-15). Ops-recorded approval channel enabled (D-11).
5. Production telephony numbers, DLT templates/headers or a Play Store listing under any brand (D-10, Q-B).
6. Technician app feature work beyond the spike until the ADR-004 gate passes (P-4).
7. Voice features beyond the simulator until P-1/P-2 pass. Telugu ASR/speech input.
8. Women-segment rating display, women-only matching, Care Visit, benefits integrations.
9. AI features that send customer text/audio to external providers.
10. Customer-facing SOS response-time promises (PB-1).
11. Waves (needs the X-07 state model). Rebook-favourite (V1.1).

## J. Final Phase 1 → Phase 2 approval checklist

| # | Condition | Status |
|---|---|---|
| 1 | Founder approves Phase 1.1 (this package) | ⚠️ Needs founder decision |
| 2 | Clarifications Q-A, Q-B, Q-C answered | ⚠️ Needs founder decision |
| 3 | Architecture blockers G-1…G-9 approved. Phase 1 errata patch (G-10) applied and reviewed | ⚠️ Needs founder decision (then ✅ after the errata) |
| 4 | Security blockers SR-02/03/05/06/07/08/17 reflected in the specs | ❌ Not ready (spec errata pending) |
| 5 | SR-01 telephony authenticity proven (P-1) | ⚠️ Needs prototype testing |
| 6 | IVR field test R1 passes thresholds, or redesign plan agreed (P-2) | ⚠️ Needs prototype testing |
| 7 | Device spike decision for ADR-004 (P-4) | ⚠️ Needs prototype testing (may run in Phase 2 week 1; blocks only app feature work) |
| 8 | Legal/CA engaged. Questions L-1…L-13 submitted. Written interim advice on L-4 before the pilot | ⚠️ Needs legal review |
| 9 | Support/safety desk staffing for pilot hours (PB-1) | ❌ Not ready |
| 10 | Team confirmed (Q20): tech lead, ≥ 2 backend, 1 mobile, 1 QA, part-time DevOps | ❌ Not ready |
| 11 | Pilot zones selected and technician supply mapped in Kurnool | ❌ Not ready |
| 12 | Manual pilot started (data SOP in place), or scheduled to run in parallel with Phase 2 foundations | ⚠️ Needs founder decision |
| 13 | AWS org/accounts, GitHub org, IdP with passkeys, provider sandbox accounts | ❌ Not ready |
| 14 | Telugu/English content owner + native-speaker reviewers identified | ❌ Not ready |
| 15 | Pricing: no final model required to start Phase 2 foundations. Required before payments go live | ✅ Ready (by design: configurable engine, fixtures only) |
| 16 | Phase 1 ADR-001…020 accepted (with G-1 amendment) | ⚠️ Needs founder decision |

**Gate rule:** Phase 2 may start with **the items in H only** when rows 1–4, 8 and 10 are satisfied. Voice work beyond the simulator waits for rows 5–6. Technician app features wait for row 7. Anything in I waits for its dependency. The thin vertical slice (Phase 1 README §12) runs end-to-end in **sandbox/test mode** until the legal and pricing dependencies clear.
