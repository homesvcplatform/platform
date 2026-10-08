# Phase 1 · 15 — Architecture Decision Records

> Status: **DRAFT for founder review** · Date: 2026-10-08
> ADR status values: **Proposed** (awaiting founder approval) · **Accepted** · **Superseded**. All ADRs below are *Proposed* until the Phase 1 gate. ADR-001…013 implement decisions the founder asked to keep. ADR-014…019 are new decisions made in Phase 1. ADR-020 is a founder-directed catalog scope revision (2026-10-08).

---

## ADR-001: Modular monolith
- **Context:** Early-stage team (≈5–8 engineers), one pilot city, ≤ 200 jobs/day in the first months. The main risks are product-market fit, operations and trust, not compute. Strong consistency is needed across jobs/quotes/payments.
- **Decision:** A single TypeScript codebase deployed as seven process roles (web-bff, api, admin-api, webhook, voice, worker, scheduler). 21 modules with their own Postgres schemas, public facades, domain events via a transactional outbox, and CI-enforced boundaries.
- **Alternatives:** Microservices (per bounded context). Classic layered monolith without boundaries. Serverless functions.
- **Reasoning:** ACID where it matters, one deploy pipeline, a smaller attack surface, and low ops cost. Process roles give the isolation that actually matters (voice and admin separated from the public API).
- **Trade-offs:** Shared DB and a single deploy unit (a bad release affects all roles, mitigated by per-role health gates and rollbacks). Boundary discipline relies on tooling.
- **Consequences:** Fitness tests (import rules, query-tag schema checks, TCP allowlist) are mandatory. Each module keeps an extraction-ready interface.
- **Revisit when:** a module needs an independent release cadence or scaling profile (likely voice/comms first), the team exceeds ~25 engineers, or DB load from one module dominates.

## ADR-002: PostgreSQL + PostGIS as the system of record
- **Context:** Transactional workflows, money, immutable records, geo (zones, localities, distance), partitioned append-only histories.
- **Decision:** PostgreSQL 17 (RDS Multi-AZ) with PostGIS, btree_gist, pg_trgm and pg_partman. Postgres is also the queue/outbox store (ADR-015). Valkey is ephemeral only.
- **Alternatives:** MySQL/Aurora MySQL (weaker constraints/GIS), MongoDB/DynamoDB (poor fit for ledger/constraints), Aurora PostgreSQL (viable later; higher baseline cost).
- **Reasoning:** Rich constraints (exclusion, partial unique, deferred triggers), mature tooling, Indian hiring pool, managed HA.
- **Trade-offs:** A single primary for writes. Vertical scaling limits are far beyond V1 needs.
- **Consequences:** Hand-reviewed SQL migrations. Partitioning designed now.
- **Revisit when:** sustained > 60% primary CPU after optimisation, or regional cells are needed. Consider PostgreSQL 18 once it is available on RDS at implementation time (minor, non-blocking).

## ADR-003: Mobile-first PWA for customers (V1)
- **Context:** Tier-2/3 customers use low-end Android phones with limited storage and data, and many will arrive via WhatsApp links. Install friction kills conversion.
- **Decision:** A Next.js server-rendered PWA with strict performance budgets (≤ 200 KB critical load, LCP < 2.5 s on throttled 3G), installable, an offline shell, and a BFF session model. Phone booking via the ops desk for non-app users.
- **Alternatives:** Native Android app. React Native. SPA without SSR.
- **Reasoning:** Zero install, fast first paint, one codebase, easy updates. Push notifications are less critical for customers (WhatsApp/SMS cover them).
- **Trade-offs:** Weaker background capabilities, iOS PWA limitations (minor in the target market), no Play Store presence.
- **Consequences:** WhatsApp/SMS are first-class status channels. Approvals by signed link + OTP.
- **Revisit when:** repeat-usage data shows retention benefits from native, or features need native APIs.

## ADR-004: React Native (Expo) Android app for technicians, with a native fallback gate
- **Context:** Technicians need reliable full-screen offer alerts, offline action queues, camera, secure storage and low-end-device performance.
- **Decision:** React Native (Expo, Hermes, bare workflow as needed), Android-first, minSdk 26. **Gate:** a 1-week spike on ≥ 3 real low-end devices must meet: cold start ≤ 4 s, APK ≤ 30 MB, offer screen interactive ≤ 1 s from push, memory ≤ 150 MB. If it fails → Kotlin + Jetpack Compose.
- **Alternatives:** Kotlin native, Flutter, PWA (unreliable background push/full-screen intents).
- **Reasoning:** Shared TypeScript types/validation with the backend and a smaller team footprint.
- **Trade-offs:** JS runtime overhead on low-end devices. Some native modules required (full-screen intent, foreground service).
- **Consequences:** The device lab is mandatory. OTA updates are tightly controlled.
- **Revisit when:** the spike fails or performance regressions persist.

## ADR-005: Basic-phone IVR as a first-class technician channel
- **Context:** Many skilled technicians use button phones. Forcing smartphones excludes them and contradicts the product thesis.
- **Decision:** Versioned IVR flows (DTMF-first, pre-recorded native prompts, PIN-gated sensitive actions, customer codes for presence), an inbound toll-free hotline, missed-call check-ins, ops-desk diagnosis capture, and two telephony providers behind `TelephonyPort`.
- **Alternatives:** SMS-only (literacy and length issues). USSD (operator dependency, limited availability). Agent-only (doesn't scale, dependency risk). Requiring smartphones.
- **Reasoning:** Voice works on every phone and suits low literacy. DTMF is robust in noise.
- **Trade-offs:** Per-minute costs, slower interactions, recording/prompt localisation effort, provider dependency.
- **Consequences:** Matching must guarantee IVR/app parity (ADR in 07). Field usability gate before launch.
- **Revisit when:** speech AI quality on 8 kHz audio in the target languages is good enough for conversational flows (V2), or telephony costs make unit economics fail.

## ADR-006: Diagnosis and repair visits as separate first-class entities
- **Context:** The core product flow is symptom → diagnosis visit → quote → approval → repair visit (possibly by a different, specialised technician, with materials), with same-visit repair as a permitted case.
- **Decision:** `Job` (customer request) → `Visit` (physical trip, own state machine, own assignment(s), own presence codes, own disclosure window) → `RepairOrder` (execution of an approved quote version, performed by one or more visits). Same-visit repair = the diagnosis visit gains the REPAIR purpose under explicit guards.
- **Alternatives:** Job-level state with a "second visit" flag (Phase 0 interpretation). Separate jobs for diagnosis and repair (breaks warranty/billing continuity).
- **Reasoning:** Different technicians, skills, schedules, materials and proofs per trip are the normal case. The model needs no special cases.
- **Trade-offs:** More entities and state machines. A coarse job status must be derived carefully.
- **Consequences:** Matching is per visit. Ratings are per technician per job. Earnings are per visit. Disclosure windows are per visit.
- **Revisit when:** multi-technician crews are needed on one visit (add `assignment.role` beyond primary).

## ADR-007: Immutable, versioned quotes with hash-bound customer approval
- **Context:** Price transparency and the rule "no silent price changes" are central to trust.
- **Decision:** Quote → versions. A version is frozen when PRESENTED (trigger + grants) and server-priced with a stored price snapshot. Approval binds to the **content hash** the customer saw and records channel evidence. Changes create a new version that needs fresh approval. The invoice can't exceed the approved total + policy fees. Decreases may auto-apply (notification only).
- **Alternatives:** Mutable quote with an audit log. Line-item-level approvals.
- **Reasoning:** Strong evidence for disputes/chargebacks, simple invariants, easy explanation to customers ("was ₹400, now ₹650").
- **Trade-offs:** More rows. UX must handle "quote changed" races gracefully.
- **Consequences:** DB triggers, API hash checks, tests for every forbidden mutation.
- **Revisit when:** never in principle. Item-level partial approval may be added later as a version feature.

## ADR-008: Double-entry ledger for all money
- **Context:** Online and cash payments, splits, commissions, refunds, chargebacks, compensation, payouts, and future taxes.
- **Decision:** An internal append-only double-entry ledger (accounts/transactions/entries) in integer paise. Deterministic idempotency keys per business event. Corrections only via compensating transactions. Nightly invariant and reconciliation jobs.
- **Alternatives:** Balance columns on entities. Relying on PA dashboards. A third-party ledger service.
- **Reasoning:** Auditability, correctness under retries and partial failure, clear technician statements, regulatory readiness.
- **Trade-offs:** Accounting knowledge is needed in the team. More upfront design.
- **Consequences:** Only the payments module writes the ledger. Account naming is finalised with a CA (⚖️).
- **Revisit when:** volume or accounting complexity justifies a dedicated ledger service/database.

## ADR-009: Stage-gated address & contact disclosure
- **Context:** Customer addresses are the most sensitive operational data. Stalking and poaching risks. Founder requirement: no full address via SMS to basic-phone technicians.
- **Decision:** Disclosure levels L0 (offer: locality, time, earnings), L1 (accepted: first name, language), **L2 (window: `max(accepted, window_start − 3 h)` → `visit end + 60 min`: exact address, masked call, media)**, L3 (after: locality only). IVR playback after PIN. App cache purged. Every L2 access logged. SMS never contains address or contact numbers.
- **Alternatives:** Reveal at acceptance until closure + 24 h (Phase 0). Address by SMS (Phase 0 §11.7 residual risk). Ops-mediated directions only.
- **Reasoning:** Minimum necessary disclosure with workable field operations.
- **Trade-offs:** Basic-phone technicians must call in to hear the address (training, call cost). A slight inconvenience if a technician wants to plan the route the night before (mitigated by the locality + distance band).
- **Consequences:** Disclosure service in jobs. Disclosure events table. Tests with time travel.
- **Revisit when:** field data shows navigation failures attributable to the window (window offsets are configurable).

## ADR-010: AI is assistive only in V1
- **Context:** AI can help with categorisation, transcription and ops summaries, but errors in pricing, safety or identity are high-impact. Inputs are untrusted (prompt injection).
- **Decision:** AI outputs are advisory, typed (closed enums), behind confidence thresholds, confirmed by a human/customer, redacted inputs, budgets + kill switch, no side-effecting tools, restricted logging with short retention.
- **Alternatives:** Autonomous voice agents. AI pricing. No AI at all.
- **Reasoning:** Value with bounded risk. Builds eval data for later phases.
- **Trade-offs:** Less automation and more ops effort in V1.
- **Consequences:** `ai` module with a provider port and redaction tests. Data-residency confirmation before production PII use (⚖️).
- **Revisit when:** eval sets show reliable performance per language and safeguards are proven (V2 conversational booking).

## ADR-011: No wallet or stored value (and no in-house financial products)
- **Context:** Wallets/credits/savings/deposits/interest raise RBI (PPI, deposit-taking) and consumer-protection exposure. The founder explicitly excluded them.
- **Decision:** No customer stored-value accounts (enforced by the ledger account-type allowlist). Refunds go to source or to a verified bank account. Technician payables are obligations paid on schedule (non-transferable, non-interest-bearing). The benefits module is a referral/consent skeleton only. Any future financial product goes through regulated partners after legal review.
- **Alternatives:** Closed-system wallet for refunds/credits. Technician savings/insurance collection in-house.
- **Reasoning:** Regulatory safety and trust.
- **Trade-offs:** Refund UX is slower than instant wallet credit. Goodwill must be a discount on the next order or a refund to source.
- **Consequences:** Allowlist test (INV-28).
- **Revisit when:** a regulated partner model is chosen with legal sign-off.

## ADR-012: No continuous GPS tracking
- **Context:** Many technicians have no GPS phone. Continuous tracking is invasive and has unclear necessity.
- **Decision:** Location for matching = registered areas + daily check-ins + last confirmed locality. Smartphone technicians may share a **one-time** consented location (≤ 30 days retention). Arrival/completion proven by customer-held codes (ADR-017). No background location collection.
- **Alternatives:** Live tracking during jobs (common in metro apps). Periodic background pings.
- **Reasoning:** Privacy, parity with basic-phone technicians, lower battery/data costs.
- **Trade-offs:** No live ETA map for customers (show "On the way" + an optional technician-shared ETA). Travel estimates are coarser.
- **Consequences:** The locality graph must be curated well. On-time metrics are based on code entry.
- **Revisit when:** customers strongly need live ETA **and** a consented, job-scoped, auto-expiring sharing feature is designed (opt-in, en-route only).

## ADR-013: Separate admin security boundary
- **Context:** Admin tools hold the keys to PII and money. Insider threats and phishing are top risks.
- **Decision:** Separate realm (company IdP SSO + phishing-resistant MFA), separate hostname behind a zero-trust proxy with device posture, separate `admin-api` process and DB role, city-scoped RBAC, masked-by-default PII with reasoned reveals, maker-checker for high-risk actions, break-glass with a 2-person rule.
- **Alternatives:** Admin routes on the public API with role checks. VPN. Third-party internal-tool builders with direct DB access.
- **Reasoning:** Defense in depth and blast-radius containment.
- **Trade-offs:** More infrastructure and some friction for ops staff.
- **Consequences:** IdP and proxy are critical dependencies (break-glass covers outages).
- **Revisit when:** partner/B2B portals need external access (a separate realm again).

## ADR-014: TypeScript end to end (NestJS, Drizzle, Zod)
- **Context:** Phase 0 recommended TypeScript. The team hasn't been finalised (Q20).
- **Decision:** Node.js LTS + NestJS (modules/DI/guards), Drizzle ORM with hand-reviewed SQL migrations, Zod schemas shared with clients and used for OpenAPI generation.
- **Alternatives:** Kotlin + Spring Modulith (strong runner-up), Python/Django, Go.
- **Reasoning:** One language across the PWA, technician app and backend. Good I/O concurrency for webhooks/IVR. Strong hiring pool.
- **Trade-offs:** npm supply-chain risk (mitigated in 14 §3). Weaker compile-time guarantees than Kotlin.
- **Consequences:** Strict TypeScript config, lint rules, dependency policy.
- **Revisit when:** the founding team composition strongly favours JVM.

## ADR-015: Postgres-backed queue, transactional outbox and durable timers
- **Context:** Workflows must survive restarts. Side effects must not be lost or duplicated. Timers (offer expiry, quote expiry, no-show) are core.
- **Decision:** **Graphile Worker** (Postgres-backed; `job_key` replace/dedupe semantics fit timers; LISTEN/NOTIFY wake-ups) + `platform.outbox` + per-subscriber jobs + `processed_events` + a 1-minute sweeper for overdue states.
- **Alternatives:** pg-boss (also viable), BullMQ/Redis (durability concerns), SQS (no transactional enqueue), Temporal (powerful, more ops).
- **Reasoning:** Transactional enqueue and one less stateful system.
- **Trade-offs:** Queue load shares the DB (fine at our scale; monitor). Not suited to very high fan-out.
- **Consequences:** Handlers are idempotent and re-check state.
- **Revisit when:** queue throughput affects DB performance, or workflows become complex enough to justify Temporal.

## ADR-016: Configurable brand identity
- **Context:** "Housefi" is a codename. The final brand depends on trademark, domain, store and company-name checks.
- **Decision:** All user-facing brand elements come from `config.brand_profiles`: name, short name, domains, support numbers, sender IDs, notification template variables, colours/logos, a **separately recorded IVR brand clip** per locale, legal entity name on invoices, and JWT issuer/cookie domains from config. Code, schemas, package names and metrics use brand-neutral identifiers. **The Android `applicationId` must be brand-neutral** (it can't change after Play publication), e.g., `in.<neutral>.partner`. DLT headers/templates are registered under a neutral or legal-entity header until the brand is final.
- **Alternatives:** Hard-code now and rebrand later (costly: Play package, DLT re-registration, prompt re-recording).
- **Reasoning:** Avoids irreversible identifiers.
- **Trade-offs:** Slight indirection in templates/prompts.
- **Consequences:** Rebrand = config + one clip per locale + store listing + DLT template update.
- **Revisit when:** the brand is final (identifiers stay neutral regardless).

## ADR-017: Customer-held one-time codes as primary presence proof
- **Context:** GPS isn't universally available or trustworthy (spoofing), but arrival and completion matter for payouts, no-shows, waiting fees and safety.
- **Decision:** Per-visit 4-digit start and completion codes, shown only to the customer, entered by the technician (app or IVR + PIN). Locked after 5 attempts. Ops override needs a recorded customer confirmation call + maker-checker.
- **Alternatives:** GPS geofencing. OTP to the technician. Photo of the door.
- **Reasoning:** Works on any phone, proves physical co-presence with the customer, is low cost, and is familiar from Indian delivery/service apps.
- **Trade-offs:** Coercion/sharing risk (customer education, timing checks), and friction when the customer isn't the person at home (a code can be forwarded by the customer to a family member, an accepted pattern).
- **Consequences:** Customer UI must surface codes clearly (PWA, WhatsApp, SMS, IVR).
- **Revisit when:** abuse patterns emerge (add a customer tap-to-confirm in the PWA as a parallel proof).

## ADR-018: Threshold-gated, batch-published segment ratings
- **Context:** The founder wants "★ from verified women customers" without exposing individuals or using gender in ranking.
- **Decision:** Optional, consented, self-declared customer gender stored as Restricted and separate from ratings. Segment aggregates computed weekly in batch, published only above k-thresholds (≥ 15 distinct raters, ≥ 20 ratings), rounded, and updated only after ≥ 3 new segment ratings (anti-differencing). Never an input to matching. Women-only matching only as an explicit, opt-in, rule-scoped filter (disabled in V1).
- **Alternatives:** Store gender on ratings. Real-time aggregates. Don't build it.
- **Reasoning:** Statistical meaning plus privacy (k-anonymity, differencing resistance).
- **Trade-offs:** The metric appears later for most technicians. Weekly freshness.
- **Consequences:** DPIA before enabling (⚖️). V1 ships the data model, but display stays off until the founder approves (D-09).
- **Revisit when:** DPIA done and enough data exists.

## ADR-019: Per-process-role database grants; no application RLS in V1
- **Context:** Phase 0 suggested enforcing module boundaries with per-module DB roles. A single pooled connection per process can't switch roles per module call without complexity and leakage risk.
- **Decision:** DB roles per **process role** (api, admin, webhook, voice, worker), with grants limited to what each role's code paths need. Append-only enforced by revoked UPDATE/DELETE + triggers. Module boundaries enforced in code + query-tag fitness tests. RLS only for human/BI read roles (city scoping, deny-all on Restricted tables).
- **Alternatives:** Per-module roles with `SET ROLE` per facade call. Full RLS with session variables.
- **Reasoning:** Real blast-radius reduction for the likeliest compromise (a public-facing task) without fragile per-call role switching.
- **Trade-offs:** Module isolation inside one process is a code-level guarantee, not a DB-level one.
- **Consequences:** Grant matrix maintained in migrations and tested.
- **Revisit when:** modules are extracted (they get their own DB roles/schemas naturally), or a multi-tenant feature needs RLS.

## ADR-020: Appliance & Home Equipment replaces standalone AC
- **Status:** Proposed (founder-directed scope revision, 2026-10-08). Catalog/scope only.
- **Context:** V1 had three top-level categories: Plumbing, Electrical, AC repair/service. Making AC a top-level category assumes high AC ownership, which isn't safe for Tier-2/3 homes, and risks an AC-shaped product.
- **Decision:** V1 replaces standalone AC with **Appliance & Home Equipment** as the third top-level category. AC becomes a service type under it, alongside Refrigerator, Washing Machine, RO/Water Purifier, Geyser, Air Cooler, Inverter, Mixer/Grinder, Microwave and TV. The Kurnool pilot enables a small set for validation (Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler). AC stays in the catalog but isn't a primary launch type. Enabled service types per city are **catalog/config data** ([03 §8.1](03-database.md#81-v1-catalog-tree-seed-example)).
- **Alternatives:** Keep AC top-level. Add each appliance as a top-level category. A generic "appliance repair" service type.
- **Reasoning:** Broader applicability to Tier-2/3 homes. Avoids assuming high AC ownership. Preserves AC as a valuable service type. Allows demand-driven expansion of appliance services. Fits the existing category → service type → specialization → repair item architecture without change.
- **Trade-offs:** More catalog content (repair items, reference prices, IVR prompts, warranty policies per service type). Technician supply must be recruited per service type and specialization. There is no generic "appliance technician".
- **Consequences:** No schema, matching, auth, security or payments redesign. Additions: `UNIQUE (service_type_id, keypad_code)` on repair items (service-type-specific IVR codes), a city-scoped `enabled` rule in `service_rules`, and seed data. The thin vertical slice covers Plumbing, Electrical and "Refrigerator not cooling", with AC as a regression scenario.
- **Revisit when:** pilot demand and technician-supply data show which appliance service types to enable, disable or add.

## ADR-021: Neutral technical identifiers
- **Status:** Accepted direction (founder Q-B, 2026-10-08). Registration of production assets deferred.
- **Context:** Several identifiers can't be changed after first use (Android application ID, Firebase project IDs, some provider account handles). Brand names (Housefi, GharSaathi) are temporary (ADR-016).
- **Decision:** Use a **neutral, descriptive, brand-independent technical namespace**: `homesvcplatform` (reverse-domain `in.homesvcplatform`). A matching operational domain `homesvcplatform.in` should be registered by the company (never shown to customers) so the reverse-domain ID corresponds to a domain we control.

| Identifier | Value | Reversible? |
|---|---|---|
| Android applicationId (technician app) | `in.homesvcplatform.technician` | **No** (permanent once published on Play) |
| Android applicationId (future customer app) | `in.homesvcplatform.customer` (reserved; not created) | **No** once published |
| Code/package namespace (TS workspaces) | `@hsp/*` | Yes (refactor) |
| Firebase/FCM project IDs | `homesvcplatform-dev`, `-test`, `-staging`, `-prod` | **No** (project IDs are permanent; display names are changeable) |
| AWS account aliases, KMS aliases, S3 bucket names | `hsp-<env>-…` | Aliases yes; bucket names need a new bucket + migration |
| Postgres schemas, metrics prefix, event types | module names, `app_` | Yes (migrations), but costly. Already brand-neutral |
| JWT `iss`, cookie domains, API hostnames | From config (`auth.<domain>`) | Yes (config + client update) |
| WebOTP domain binding in SMS | Customer-facing domain (brand) | Yes (template update) |
| **DLT entity/header (SMS sender ID)** | **Not chosen.** DLT headers must correspond to the registered entity/brand and are approved by operators, so a purely "neutral" header may be rejected. Use a **legal-entity-derived header** once the entity is incorporated, or the final brand | Header registration is per header. New headers can be added later; old ones can be retired |
| WhatsApp Business display name | Brand (later) | Yes (with Meta re-approval). The phone number is sticky |
| Play Store listing title, app name, icons | Brand (config/store listing) | Yes |

- **Checks performed (2026-10-08):**
  - Google Play listing lookups for `in.homesvcplatform.technician` and `in.homesvcplatform.customer` returned **HTTP 404** (no public listing), while a known package returned 200.
  - DNS: `homesvcplatform.in` doesn't resolve.
  - RDAP lookups for `homesvcplatform.in` and `homesvcplatform.com` returned **not found**.
  - A web search found no use of the string.
  - **Limitations:** a 404 doesn't prove that no private/unlisted app uses the ID. Play enforces uniqueness only at first upload. Domain availability can change until registered. No trademark search was done for "homesvcplatform"; it's descriptive and not customer-facing.
- **Alternatives:** brand-based IDs (rejected: irreversible); legal-entity-based IDs (the entity name isn't final); random strings (hard to manage).
- **Consequences:** Founder action: register `homesvcplatform.in` and create the Play Console app with this ID in an **internal testing track only** when the technician app spike starts (claims the ID without publishing). **No production Play/DLT assets are registered now.**
- **Revisit when:** never for the applicationId once claimed. The DLT header is chosen at entity incorporation.

## ADR-022: Gate 1 foundation decisions (Phase 2 implementation addendum)
- **Status:** Accepted by the founder (2026-10-08); proposed with Gate 1. Each item implements an already-approved decision; none changes product scope.
- **Context:** Implementing Gate 1 required choices the Phase 2 docs left open, and it exposed one structural inconsistency.

| # | Decision | Reasoning / trade-off |
|---|---|---|
| 1 | **Transactional coupling points use dependency inversion.** TCP-2 (`jobs` → `diagnosis.recordMaterialUsage`) and TCP-3 (`jobs` → `payments.issueBill`) are **ports declared in `jobs/public`** (`MaterialUsageRecorder`, `BillIssuer`), implemented by `diagnosis`/`payments` and wired by apps. `payments` gains a compile-time edge to `jobs` (to implement the port). | **Found during Gate 1:** calling these modules directly from `jobs` would create import cycles (`diagnosis` → `jobs`, `payments` → `diagnosis` → `jobs`). Inversion keeps the graph acyclic while the calls still join the same transaction. TCP semantics are unchanged |
| 2 | **`identity` sends OTPs through an `OtpSender` port** (implemented by `comms`), not a direct dependency | Phase 1 01 §4.2 listed `identity` → `comms`, but §4.3 has `comms` → `identity`, which is a cycle. The port removes it |
| 3 | Toolchain pinned exactly: pnpm 10.34.5, Turborepo 2.11.3, TypeScript 6.0.3, ESLint 10.11.0 + typescript-eslint 8.70.1, Vitest 5.0.1, dependency-cruiser 18.4.0, Zod 4.6.5, Node 24 LTS | Every version is at least 2 weeks old. TypeScript 7.x was **not** chosen: typescript-eslint 8.70 supports TypeScript < 6.1. pnpm 12 was not chosen to stay on the well-known pnpm 10 line |
| 4 | **Backend runs TypeScript sources directly with Node 24 type stripping** (`erasableSyntaxOnly`), with no build/transpile step | Smallest correct pipeline: the image contains the exact reviewed sources. Constraint: no TS-only runtime syntax (enums, namespaces, parameter properties), enforced by the compiler |
| 5 | **Frameworks are introduced in the gate that needs them:** NestJS (Gate 3), Next.js for `web-bff` (Gate 3/8), Vite admin SPA (Gate 3/8), Expo (Gate 9, **after Spike S-2**) | Avoids installing unused frameworks. Gate 1 roles boot through a minimal kernel runtime (config validation + guardrails + health endpoint) |
| 6 | One backend image for all server roles. **Distroless `nodejs24` non-root base pinned by digest**. Read-only root FS, all capabilities dropped. Role selected by the task command | Matches Phase 1 "one image, multiple process roles". `media-scanner` uses the same image for now and gets its own image when decoders are added (SR-09) |
| 7 | **Images are signed keyless with Sigstore cosign via GitHub OIDC**, with a CycloneDX SBOM attestation. Deploys verify both, and an **organisation SCP** limits ECS task-definition/service changes to `hsp-*-deploy` roles | Implements SR-16 without long-lived signing keys. Depends on public Sigstore infrastructure (Fulcio/Rekor) |
| 8 | Fargate tasks use **X86_64** in Phase 2 | Avoids QEMU cross-builds on CI. Graviton/ARM64 (Phase 1 14 §2.2) is a later cost optimisation |
| 9 | Workspace naming: `@hsp/<shared>`, `@hsp/module-<name>`, `@hsp/adapter-<name>`, `@hsp/app-<role>` | ADR-021 neutral namespace. Enforced by `tools/architecture/check-workspace.mjs` |
| 10 | Until Gate 3 splits client and server code, the **whole `web-bff` app is treated as a frontend** for boundary rule B7 | Safer default. Gate 3 adds a server-only directory exception for the BFF |
| 11 | *(Added 2026-10-08, founder-approved Gate 1 issue I-2 Option A.)* **The image registry and the CI build role live in the shared-services account** (Phase 1 14 §2.1), not in each workload account. `infra/envs/shared-services` holds one immutable, KMS-encrypted ECR repository (`hsp-shared-backend`, `infra/modules/registry`) and the GitHub OIDC build role (`hsp-shared-ci-build`, main branch only, `infra/modules/ci-build`). dev/test pull cross-account: the repository and key policies allow only their `hsp-*-task-execution` and `hsp-*-deploy` roles. dev/test receive the registry ARN, URL and key ARN as explicit Terraform inputs. Deploy roles stay in each workload account | Corrects a Gate 1 deviation from Phase 1. It also fixes the test deploy path: CI builds and signs once, and dev and test deploy the same digest from one registry. Trade-off: one more account to run, and runtime pulls depend on a cross-account policy |

- **#11 amendment (2026-10-08, founder-approved with Gate 1 temporary exception TE-01):** the same decision, made applicable and tightened. No change of direction.
  - The registry's consumer-account list may be empty, meaning no cross-account access, until the dev/test accounts exist. Placeholder account IDs are never used.
  - The repository policy has an explicit Deny on push for every principal except `hsp-shared-ci-build`, because a same-account IAM allow would otherwise permit administrators to push.
  - TE-01 (dev/test accounts delayed by the AWS account quota) is a temporary exception, not an architecture change. It is recorded in `docs/phase-2/GATE-1-CLOSURE-CHECKLIST.md` §0.
- **Consequences:** `tools/architecture/modules.json` is the single source of truth for module dependencies (generates the dependency-cruiser rules). Any new module edge requires an ADR change.
- **Revisit when:** ARM64 builds are needed (cost), or the type-stripping constraint becomes limiting.

---

## ADR-023: Gate 2 database foundation decisions (Phase 2 implementation addendum)
- **Status:** Proposed with Gate 2 (2026-10-09). Founder acceptance is part of the Gate 2 review. Each item implements an already-approved decision or records a necessary deviation from the Phase 1 DDL text; none changes product scope.
- **Context:** Gate 2 turns the Phase 1 design DDL into migrations under TE-02 (local / GitHub CI only, throwaway PostgreSQL 17 + PostGIS, synthetic data, no AWS).

| # | Decision | Reasoning / trade-off |
|---|---|---|
| 1 | **Driver `pg` 8.23.0, raw SQL migrations, no ORM for schema.** Drizzle table definitions (Phase 2 02 §2.1) arrive with the first module repositories (Gate 3+) | Smallest correct dependency set. Migrations are reviewed SQL either way |
| 2 | **Own forward-only runner in `@hsp/db`**: `NNNN_<schema>__<desc>.sql`, SHA-256 ledger in `platform.schema_migrations`, advisory lock, one transaction per file with `SET LOCAL lock_timeout/statement_timeout`, refuses a superuser, an edited applied migration or a database ahead of the directory. **squawk v2.65.0** lints in CI (binary verified by SHA-256) with four justified exclusions (`.squawk.toml`) | ~150 lines, fully tested, enforces 03 §14.7 exactly. Avoids a migration-tool dependency |
| 3 | **Bootstrap vs migrations split.** An admin-only, idempotent bootstrap creates the NOLOGIN group roles, the non-superuser `migrator` login, extensions and database CONNECT/CREATE rights. Migrations then run as `migrator`. Runtime login users are members of exactly one group role (created per environment when AWS resumes, IAM auth) | Managed databases have no superuser for the app (TE-02 restriction 2). Role creation and extensions need admin rights; everything else doesn't |
| 4 | **Partition templates without pg_partman**: `platform.ensure_monthly_partitions(parent, back, ahead)` creates `parent_pYYYYMM` with UTC month bounds (last month to +3 now). `pg_partman`, `pgaudit` and `pg_stat_statements` are adopted on the managed database (TE-01) | They aren't in the local/CI PostGIS image. The function produces the same layout pg_partman would take over |
| 5 | **Classification as column comments** set by `platform.classify(table, default, overrides…)`; a DB test fails on any untagged column. **Key-subject registry** `platform.encrypted_columns` (G-7 / SR-07 (1)); **archive policy** `platform.archive_policies` + view `platform.archive_columns` (P / I columns only) | Machine-checkable, lives with the schema, and a later `ADD COLUMN` without a tag fails CI |
| 6 | Guard triggers raise **SQLSTATE class `HS`**: HS001 append-only, HS002 immutable, HS003 transition, HS010 ledger, HS020 cross-row | Stable, testable error codes for the application layer |
| 7 | **Deviations from the Phase 1 DDL text:** `visits.window` → `service_window` (`WINDOW` is reserved); `quote_versions` may go DRAFT → WITHDRAWN without `presented_at`; `pricing.rate_cards.label` added (fixture / human naming); `catalog.service_categories`, `specializations`, `symptoms` defined (03 §8 was abridged); extra defensive CHECKs (payout activation only after cooling-off and maker-checker for non-app creation, `offer_id` unless MANUAL_OPS, G-8 sign rules on bill lines, ledger account owner/type consistency, currency = INR) | Each tightens or makes the spec compilable. None loosens a Phase 1 rule |
| 8 | **Gate 2 table scope:** slice modules per 03 §Gate 2 (+ `backoffice.approval_requests` for INV-19). Every other module owns its (empty) schema now. Trust complaints / disputes / sanctions / safety, verification, voice, comms, ai and benefits tables arrive with their gates. Status-transition guard triggers for jobs / visits / assignments / repair orders arrive with the state machines at Gate 5. Quote, diagnosis and coverage transitions are guarded now | Gate 2 deliverables only; no Gate 3+ work |
| 9 | **Grant matrix follows 03 §12.1 literally.** `app_voice` has `INSERT` only on `payments.cash_collections` (X-11), so it cannot issue the TCP-3 bill. **Founder decision (2026-10-09), least privilege:** `app_voice` gets **no** direct permission to create bills (`payments.bills` / `bill_lines`). IVR-driven completions go through the authorized API / service path, which runs the bill-issuance transaction. Implemented with the IVR / payments work (Gate 10/11), not in Gate 2 | The voice surface stays as narrow as 03 §12.1 says. `app_api` already holds INSERT on `payments.bills` / `bill_lines`, so no grant migration is needed now; the routing is built at Gate 10/11 |
| 10 | **Fixture-only envelope crypto** in `@hsp/testing` (documented format, key derived from a public label) for synthetic seed data. Replaced by `@hsp/security` field crypto at Gate 3 | Encrypted columns hold realistic bytes now. Nothing real is ever encrypted with it |
| 11 | **DB tests are CI-only** (`pnpm run test:db` in the required `verify` job, PostGIS 17 service container pinned by digest). `pnpm run ci` stays database-free | No Docker on the founder's workstation (TE-02 restriction note) |
| 12 | **Transitive pin `rolldown` 1.2.11** (pnpm override): the Gate 1 lockfile held a one-day-old `rolldown` 1.2.13 under `vite`, violating ADR-022 #3 | Supply-chain rule applied to transitive packages too |

- **Consequences:** every future migration must classify new columns and register encrypted ones; grant changes are visible as migrations and checked by the grant-matrix test.
- **Revisit when:** the managed database exists (adopt pg_partman / pgaudit, re-run migrations and the grant matrix on RDS: TE-02 restriction 8), or Gate 10/11 implements the IVR-completion routing decided in item 9.
