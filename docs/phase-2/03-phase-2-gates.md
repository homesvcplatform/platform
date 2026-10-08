# Phase 2 · 03 — Gates

> Status: **DRAFT for founder approval** · Date: 2026-10-08
> **No gate is skipped silently.** A gate passes only when every exit criterion is met and the gate review is recorded (§14). Work on the next gate may *start* in parallel only where the dependency column allows, but nothing merges into a later gate's scope until its prerequisites pass.
> Global constraints for every gate: security first · no secrets in source · no production credentials · **no real customer PII** · no real payments · no production telephony · no production KYC · no public buckets · no client DB access · no trust in client business rules · server-authorised state changes · idempotent critical mutations · restart-safe workflows · every authZ rule tested · every invariant tested.

---

## Gate 1: Repository, CI/CD, security scanning
| | |
|---|---|
| **Objective** | A secure skeleton that enforces architecture rules before any feature exists |
| **Deliverables** | Monorepo per [02](02-repository-structure.md). Empty module packages with `public` entries. Boundary rules B1–B12 wired. CI pipeline (lint, typecheck, unit, dependency-cruiser, gitleaks, Semgrep, OSV, Trivy, Checkov, SBOM, cosign signing). IaC for `dev`/`test` (VPC, ECS cluster, RDS, Valkey, S3 with Block Public Access, KMS keys per data class, Secrets Manager, OIDC deploy roles). Signed-image deploy path (SR-16). CODEOWNERS. PR template |
| **Exit criteria** | A deliberate boundary violation fails CI. A planted fake secret fails CI. An unsigned image can't be deployed (test). A non-pipeline role can't register a task definition (test in `dev`). S3 public-access attempt denied (Config rule). `dev` and `test` environments reachable only as designed |
| **Errata applied** | SR-16, SR-11 (no CORS middleware by default), X-26 |
| **Depends on** | Founder approval of Phase 2. AWS org/accounts, GitHub org (founder action). **AWS deployment deferred by founder decision (2026-10-09)**: the AWS-dependent exit criteria are deferred under TE-01, and development uses the `local` and CI environments ([GATE-1-CLOSURE-CHECKLIST §0](GATE-1-CLOSURE-CHECKLIST.md#0-temporary-exceptions-founder-approved-2026-10-08)) |

## Gate 2: Database foundation, migrations, constraints
| **Objective** | Schemas, roles, grants and core constraints proven by tests |
|---|---|
| **Deliverables** | Migration runner + `squawk`. Schemas per module. **Per-process DB roles and grant matrix** (G-5). Append-only triggers. Partition templates. Core tables for slice modules (identity, customers, workforce, catalog, geo, pricing, jobs, diagnosis, matching, payments/ledger, warranty, trust minimal, compliance audit/consent/disclosure, files, platform outbox/idempotency). Key-subject registry for encrypted columns (G-7/SR-07). Query-tag fitness test. Synthetic seed loader (Kurnool test zones, catalog tree, rate-card fixtures) |
| **Exit criteria** | DB constraint tests green: INV-01, 05, 07, 10, 11, 12, 16, 19 at SQL level. Grant matrix test (non-worker roles can't write the ledger; webhook role insert-only). Append-only UPDATE/DELETE rejected. Migrations reversible-by-forward-fix rehearsed. No PII column without a classification tag |
| **Errata applied** | G-5, G-7 (registry + archive policy), G-8 (line types), G-9 (CHECKs), X-05, X-24 columns, X-34 columns, Q-C column |
| **Depends on** | Gate 1. **Temporary exception TE-02** (founder-approved 2026-10-08) lets Gate 2 start before Gate 1 is PASS, once G1–G9 are recorded and the founder says "start Gate 2". Restrictions: local/CI only, no AWS, synthetic data, Gate 3 not started, decision capped at PASS WITH CONDITIONS until an RDS re-run. See [GATE-1-CLOSURE-CHECKLIST §0](GATE-1-CLOSURE-CHECKLIST.md#0-temporary-exceptions-founder-approved-2026-10-08) |

## Gate 3: Identity, authentication, authorization
| **Objective** | Every request is authenticated and authorised by tested policy |
|---|---|
| **Deliverables** | Phone OTP (fake SMS adapter), sessions, refresh rotation with reuse detection, BFF cookie sessions (customer + **agent web**), signed client-IP header over mTLS (G-6/SR-10), step-up, IVR PIN credential store, admin SSO via a **test IdP** + passkey enforcement, policy engine + registry, audit log (hash-chained), field crypto with per-class keys + encryption context (SR-06), allowlist logger + canary-PII test, rate limiter |
| **Exit criteria** | Authorization-matrix generator running for all implemented endpoints (default deny). ST-08…ST-12, ST-27, ST-28 green. Refresh reuse revokes the family. No tokens in browser storage (SR-02). KMS decrypt denied for roles without the class grant. Canary-PII scan: 0 hits |
| **Errata applied** | G-6, SR-02, SR-03 (passkey step-up primitive), SR-06, SR-10, SR-14 (new-device hold rule), X-14, X-32 |
| **Depends on** | Gate 2 |

## Gate 4: Catalog, localization, geo
| **Objective** | All category/service-type/locale/geo content is data, with no hard-coding |
|---|---|
| **Deliverables** | Catalog module (3 categories, the appliance service types from the approved tree, specializations, symptoms, repair items with **service-type-scoped keypad codes**, materials, reference prices, service rules incl. city-scoped `enabled`). Localization registry (te-IN, en-IN) + enablement gate. Geo (cities, zones, localities, aliases, adjacency) with **synthetic** Kurnool-like test zones |
| **Exit criteria** | Enabling/disabling a service type for a city changes catalog API output without a deploy (test). Missing-translation check blocks locale enablement. No category/service-type string literals in app code (lint for known codes) |
| **Errata applied** | ADR-020 catalog tree, X-05 |
| **Depends on** | Gate 2 (Gate 3 for admin edits) |

## Gate 5: Jobs, visits, assignments, state machines
| **Objective** | The fulfilment core is correct, restart-safe and idempotent |
|---|---|
| **Deliverables** | Job/Visit/Assignment/RepairOrder aggregates with transition tables + DB transition guards. Histories. Durable timers + sweeper. Disclosure service (L0–L3 + customer-verified rule G-4). Presence codes. Waits. Cancellation evaluation (policy snapshot). Booking idempotency + soft duplicate check. **TCP-3 seam** (bill issuance call; stubbed until Gate 11 with a deterministic fake that's replaced, not bypassed) |
| **Exit criteria** | Property tests over transition tables (no illegal transition reachable). INV-01, 03, 04, 14, 15, 17, 18, 25 green. Kill-worker timer recovery test. Duplicate booking test. Time-travel disclosure tests incl. unverified customer. Adult-present field required |
| **Errata applied** | G-1 (seam), G-4, X-01, X-02, X-20, X-30, X-34, X-35 |
| **Depends on** | Gates 3, 4 |

## Gate 6: Diagnosis and quote engine
| **Objective** | Prices are computed only by the server, quotes are immutable, and approvals are hash-bound |
|---|---|
| **Deliverables** | Diagnosis drafts/submission (app + ops-desk capture). Pricing engine reading configurable rate cards (**fixtures only**, Model B and C configs for tests; no final values). Quote versions + items incl. `VISIT_FEE_CREDIT`. Content hash. Approval channels: app session, signed link (fragment token, SR-05) + OTP. **Ops-recorded channel implemented but flag-off.** Q-A repair-option logic. Repair order creation from `QuoteApproved`. **Change-order (v2) flow** |
| **Exit criteria** | INV-05, 06, 07, 08, 09, 21 green. Change-order integration test (no work on new items before approval). Separation-of-duties tests (G-9). Pricing property tests (totals = Σ signed lines, rounding). Margin-warning hook from the simulator formulas on rate-card activation |
| **Errata applied** | G-8, G-9, SR-05, Q-A, D-07 (configurable only) |
| **Depends on** | Gate 5 |

## Gate 7: Matching
| **Objective** | Fair, explainable, per-visit matching |
|---|---|
| **Deliverables** | Candidate pool + hard filters H1–H18 (incl. H18 cash cap, H16 conflict of interest). Scoring (travel via locality graph, reliability, on-time, rating, workload, fairness). Exclusive offers + cascade. Direct offers (same technician). **Offer hold during IVR calls (G-2)**. **Overlap-based offer concurrency (G-3)**. Match explanations. Fairness ledger. Waves **not** built (X-07 deferred) |
| **Exit criteria** | INV-02, 03, 20 green. G-2/G-3 concurrency tests. Skill specificity tests (fridge ≠ RO ≠ AC; gas specialization). Parity metric computed in simulation. Every match run fully logged |
| **Errata applied** | G-2, G-3, X-24 (H18), X-28 (ETA-confirmation signal) |
| **Depends on** | Gates 5, 4 |

## Gate 8: Customer PWA
| **Objective** | The slice's customer journey, usable on low-end Android over poor networks, in Telugu and English |
|---|---|
| **Deliverables** | Screens per [04-ui-information-architecture](04-ui-information-architecture.md) for the slice: language, symptom-first booking, address + landmark, payment preference, "who will be home", visit fee, OTP, tracking, technician card + identity check, codes, quote + Q-A options, payment (sandbox), receipt placeholder, warranty card, rating, SOS screen (112 first, no unstaffed promises), privacy/consent basics |
| **Exit criteria** | Performance budget (≤ 200 KB critical, LCP < 2.5 s on throttled 3G mid-tier device profile). axe: 0 serious/critical. TalkBack walkthrough of the booking + quote. Telugu rendering at 200% scale. Moderated test with ≥ 5 target users (pilot region or proxies) with findings logged. ZAP baseline clean |
| **Errata applied** | X-33, X-34, SR-05, SR-13 (copy), Q-C |
| **Depends on** | Gates 3–6 (UI work can start against contract mocks after Gate 3) |

## Gate 9: Technician app foundation
| **Objective** | A spike-validated app shell that stays useful offline |
|---|---|
| **Prerequisite** | **Spike S-2 (device matrix, ADR-004 decision)** passes ([1.1/08](../phase-1.1/08-device-test-matrix.md)) |
| **Deliverables** | Login + device binding (≤ 2 accounts per device, SR-20). Offer screen (slide-to-accept, earnings). Active visit (L2 window, purge at close). Depart/arrive (code). Diagnosis builder (catalog per service type). Completion + material usage. Cash record. Earnings summary. SOS (`tel:` links work offline). Offline queue with idempotency (7-day keys). PUSH_THEN_IVR trigger |
| **Exit criteria** | Device-matrix targets on the slice flows. Offline replay tests. Local purge test. Crash-free ≥ 99.5% in closed test. MobSF scan clean (high/critical) |
| **Errata applied** | SR-20, X-20, X-32, D-03 (slide-to-accept) |
| **Depends on** | S-2, Gates 3, 5–7 |

## Gate 10: IVR simulator
| **Objective** | The full IVR logic running against a **deterministic telephony simulator**, with **production IVR state changes disabled** |
|---|---|
| **Deliverables** | Flow engine + versioned flow definitions (offer, hotline, check-in, quote approval, cash confirmation, SOS, masked bridge) in te-IN/en-IN with recorded placeholder prompts. PIN gate. Visit read-back + double confirmation (D-03). Language switch (X-31). Offer hold signalling (G-2). Ops diagnosis-desk bridge (simulated). Telephony simulator adapter. Flag `ivr_production_state_changes = false` everywhere. A real provider adapter exists only after S-1 passes and is limited to `staging` sandbox numbers |
| **Exit criteria** | Every node/edge covered by flow tests (drops, timeouts, invalid input, PIN lockout). Forged-event tests against the simulator (accept, arrive, complete, cash-confirm with bad signature/nonce/ended call) all rejected. Step latency p95 < 800 ms in `test` |
| **Errata applied** | G-2, X-27, X-31, SR-12 (no digits stored), SR-21 |
| **Depends on** | Gates 5–7. **Spike S-1 for any real-provider work** |

## Gate 11: Payments and ledger (test mode)
| **Objective** | Correct money accounting with **sandbox/test money only** |
|---|---|
| **Deliverables** | Bills (TCP-3 real implementation), payment intents against the **PA sandbox**, webhook verification + server fetch, cash collections + customer confirmation, ledger (worker-only writes), statements, payout **batch preview only** (no execution), refunds against the sandbox (maker-checker), invoice **placeholder** PDF watermarked "TEST: NOT A TAX INVOICE" via programmatic PDF (SR-08), reconciliation job against sandbox reports |
| **Exit criteria** | INV-09, 10, 11, 12, 13, 23, 24, 28 + ledger L1–L10 green. ST-17…ST-20 green. Forged/duplicate/out-of-order webhook tests. No code path assumes Model A/B legal flow beyond the sandbox (review). No tax lines active |
| **Errata applied** | G-1 (complete), G-5, G-8 (ledger postings), SR-08, SR-18, D-08 constraint |
| **Depends on** | Gates 5, 6. PA sandbox account (founder action) |

## Gate 12: End-to-end vertical slice
| **Objective** | The four scenarios in [05-first-slice-spec](05-first-slice-spec.md) pass end to end in `test` and `staging` |
|---|---|
| **Exit criteria** | Scenarios 1–4 automated and green. Kill-worker and duplicate-submission tests. Canary-PII 0 hits. Fitness tests green (TCP-1/2/3 only). SLO checks under 5× pilot-like synthetic load in staging. Founder demo. Phase review (architecture, security, UX, tech debt) recorded |
| **Depends on** | Gates 1–11 |

---

## Spike S-1: telephony authenticity (SR-01)

**Hard blocker for any production IVR state change.** A disposable spike in a sandbox AWS account, not merged into the product repo (findings and fixtures are). It can run in parallel with Gates 1–4.

**Setup:** ≥ 2 Indian telephony providers (shortlisted per vendor checklist SR-23). Test numbers only. A throwaway webhook service in `ap-south-1`.

| # | Property to prove | Method | Pass criterion |
|---|---|---|---|
| 1 | Webhook authenticity | Inspect provider docs + traffic: request signing (HMAC/JWT), mTLS, or equivalent | A cryptographic signature verifiable by us, **or** a documented combination of IP allowlist + per-call secret URL nonce + an API callback verification that the founder accepts as equivalent |
| 2 | Request signing or equivalent | Tamper with body/headers | Tampered requests rejected |
| 3 | Replay protection | Re-send captured valid requests | Rejected (timestamp window + nonce/event-ID dedupe) |
| 4 | Provider-side call identity | Query the provider API for call SID → from/to/status | The call exists, is in progress, and numbers match our session |
| 5 | Call SID/session verification | Requests with a valid format but a foreign/ended SID | Rejected |
| 6 | State-change protection | State-changing nodes require (1)+(4) before commit | No state change without verification |
| 7 | Masked calling | Bridge customer↔technician with a virtual number, window-bound, registered-number-only | Works. Rejects other callers and calls outside the window |
| 8 | Callback authenticity | Status callbacks (completed/no-answer) verified like flow requests | Forged status callbacks rejected |
| 9 | Failure behaviour | Webhook timeouts, 5xx, slow responses | Provider fallback prompts play. No partial state. Our timeouts < provider limits |
| 10 | Provider outage fallback | Disable provider A | Outbound via provider B. SOS static routing to the ring group works with the backend down |
| 11 | DTMF/log masking (SR-12) | Inspect provider console/logs | Masking or no-logging available, or the residual documented |
| 12 | Latency | Step round-trip from Mumbai | p95 < 800 ms |

**Forgery tests (must all be rejected, with alerts):** forged **accept** (DTMF 1 on an offer), forged **arrive** (start code), forged **complete** (completion code), forged **cash-confirmation** (customer "1 yes"). Each is attempted with: no signature, a wrong signature, a replayed valid request, a valid signature but a foreign call SID, an ended call, and a correct call but a wrong nonce.

**Outcome:** a provider decision record (feeds an ADR), adapter requirements, and an updated threat model. **Until S-1 passes for the chosen provider(s), `ivr_production_state_changes` stays false and real-provider adapters can't change state in any environment.**

## Spike S-2: technician device matrix (ADR-004)
Per [1.1/08](../phase-1.1/08-device-test-matrix.md). Must pass before Gate 9 feature work.

## Field validation (parallel, outside engineering gates)
- IVR field test R0–R2 ([1.1/07](../phase-1.1/07-ivr-field-test.md)): must pass before any **real-technician** IVR use (pilot or later).
- Manual concierge pilot ([1.1/09](../phase-1.1/09-manual-pilot.md)): runs in parallel. Its findings feed catalog/pricing/IVR content, not the gate order.

---

## 14. Gate review template
For each gate: scope delivered vs planned · exit criteria evidence (links to CI runs/test reports) · errata items applied · security review notes (new threats, findings) · UX notes (if user-facing) · tech debt register delta · known risks · decision: **PASS / PASS WITH CONDITIONS / FAIL** · approver(s).
