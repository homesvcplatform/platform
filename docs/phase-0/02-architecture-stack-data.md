# Phase 0 · Part 2 — Architecture, Stack, Data (Sections 7–9)

> Status: **DRAFT for review** · Date: 2026-10-08

---

## 7. System architecture proposal

### 7.1 Modular monolith vs microservices

| Criterion | A. Modular monolith | B. Microservices |
|---|---|---|
| Time to first production release | **Fast.** One repo, one deploy pipeline, one DB. | Slow. Service scaffolding, contracts, infrastructure for each service. |
| Consistency (jobs ↔ quotes ↔ payments ↔ ledger) | **ACID transactions** across modules where needed. Outbox for side effects. | Distributed transactions/sagas everywhere. Eventual consistency even where it isn't wanted (e.g., quote approval ↔ ledger). |
| Reliability | Fewer network hops and fewer partial-failure modes. | Many more failure modes: timeouts, version skew, cascading failures. |
| Security surface | One authN/authZ layer, one secrets set, one network perimeter per deployable. | Service-to-service auth, mTLS, more secrets, more endpoints to harden. |
| Ops cost (people + cloud) | **Low.** A team of 4–8 engineers can run it. | High. Needs platform/SRE capacity a startup doesn't have. |
| Scaling | Horizontal scaling of stateless processes. Separate process roles (API/worker/voice) scale independently. Postgres scales vertically far beyond our year-3 needs. | Fine-grained scaling. We don't need it at our volumes. |
| Team autonomy | Module ownership with enforced boundaries. | Strong autonomy. Useful at 50+ engineers, not 5. |
| Risk of "big ball of mud" | Real, **if boundaries aren't enforced** (mitigation below). | Lower coupling, but a distributed monolith is the common failure mode. |

**Recommendation: Option A, a modular monolith with strictly enforced module boundaries, deployed as several process roles from one codebase.**

**Why, in numbers:** an ambitious year-3 target of 100 cities × 2,000 jobs/day is 200k jobs/day, about **2.3 jobs/sec on average** and maybe 25/sec at peak. Each job generates perhaps 50–150 DB writes over its lifetime. That is a **small** load for a single well-tuned PostgreSQL primary. Our real scaling constraints are **operations, telephony capacity, supply quality and trust**, not compute. Microservices would spend our scarcest resource (engineering attention) on a problem we don't have.

**Extraction-readiness rules** (so we *can* split later):
1. Each module owns its tables in its **own Postgres schema** (`identity.*`, `jobs.*`, `payments.*`…). No module reads or writes another module's tables. This is enforced by DB grants per module role in CI tests, and by a lint rule (dependency-cruiser) on imports.
2. Modules talk only through (a) a **public interface** (TypeScript facade, in-process call) and (b) **domain events** via the transactional outbox.
3. Cross-module references are **IDs only**: no cross-schema foreign keys except to `identity.users`, and those are reviewed.
4. Each module has its own config namespace, metrics prefix and test suite.
5. Integration adapters (telephony, payments, SMS, maps, AI) sit behind **ports** (interfaces), so vendors can be swapped and tests can use fakes.

**Likely first extractions (only when justified by data):** Voice/IVR gateway (different latency/availability profile, bursty webhooks), Notifications dispatcher, AI gateway, Matching engine (compute-heavy at multi-city scale), Analytics pipeline.

### 7.2 Module map (bounded contexts)

| # | Module | Owns | Key responsibilities |
|---|---|---|---|
| 1 | **identity** | users, devices, sessions, refresh tokens, OTP challenges | Phone+OTP auth, token issuance, device binding, IVR PIN. Admins live in a separate realm (module 16). |
| 2 | **customers** | customer profiles, addresses, preferences | Customer data, address book, communication preferences. |
| 3 | **workforce** | technician profiles, skills, service areas, availability, daily check-ins, field agents, payout methods | Supply side: onboarding states, verification levels, capacity. |
| 4 | **verification** | documents, verification records, BGV vendor results | KYC/BGV orchestration through vendors. Document lifecycle. |
| 5 | **catalog** | service categories, service types, symptoms, repair catalog, materials, reference prices | What we sell and how it is described, in every language. |
| 6 | **pricing** | rate cards, fee rules, commission rules, cancellation/waiting policies, price snapshots | Versioned, effective-dated rules. Pure calculation functions. Maker-checker. |
| 7 | **jobs** | jobs, visits, assignments, status history, cancellations | Job state machine. The central coordinator of the lifecycle. |
| 8 | **diagnosis** | diagnoses, quotes, quote items, approvals, material usage | Diagnosis entity. Immutable quote versions. Approval proofs. |
| 9 | **matching** | match runs, candidates, offers, dispatch config | Candidate selection, scoring, offer cascade, fairness. |
| 10 | **voice** | call sessions, IVR interactions, call recordings metadata, prompt catalog | Telephony adapter, IVR flow engine, masked calling. |
| 11 | **comms** | notifications, templates (DLT IDs), delivery attempts, preferences | Push/SMS/WhatsApp/voice-notification orchestration, fallbacks. |
| 12 | **payments** | payment intents, payments, refunds, payouts, invoices, **ledger** | PA integration, double-entry ledger, reconciliation, payouts. |
| 13 | **warranty** | warranty policies, coverages, claims | Coverage snapshot, eligibility, claim workflow. |
| 14 | **trust** | ratings, reviews, complaints, disputes, safety incidents, fraud signals, blocks | Trust & safety workflows, investigations, appeals. |
| 15 | **geo** | cities, zones, localities, geocoding cache | Zone polygons (PostGIS), locality graph, travel estimates. |
| 16 | **backoffice** | admin users, roles, permissions, approvals (maker-checker), admin sessions | Separate auth realm, RBAC/ABAC, admin APIs. |
| 17 | **compliance** | audit log, consents, consent events, data-rights requests, retention jobs | Audit trail, DPDP workflows, retention/erasure execution. |
| 18 | **ai** | prompt versions, AI request log (restricted), eval results | Provider abstraction, redaction, budgets, confidence handling. |
| 19 | **config** | feature flags, system settings | Runtime configuration, kill switches. |
| 20 | **benefits** *(skeleton)* | benefit programs, partner refs, enrollments (consent-based) | Integration surface for regulated partners later. |
| 21 | **files** | file objects, scan status | Upload pipeline, malware scan, signed URLs. |

### 7.3 Runtime topology

```mermaid
flowchart LR
  subgraph Clients
    CPWA[Customer PWA]
    TAPP[Technician Android app]
    BP[Basic phone<br/>PSTN]
    WA[WhatsApp]
    ADM[Admin console<br/>internal only]
  end

  subgraph Edge
    CDN[CDN + WAF<br/>rate limits, bot rules]
    ZT[Zero-trust access proxy<br/>SSO + MFA + device posture]
  end

  subgraph Telephony["Telephony provider (India)"]
    EXO[IVR / outbound / masked calls / SMS]
  end

  subgraph App["Housefi modular monolith (one codebase, multiple process roles)"]
    API[api role<br/>customer + technician REST]
    ADMAPI[admin-api role<br/>separate hostname & network]
    HOOKS[webhook role<br/>payments, telephony, WhatsApp]
    VOICE[voice role<br/>IVR flow engine]
    WORK[worker role<br/>outbox relay, jobs, retries,<br/>matching cascades, reconciliation]
    SCHED[scheduler role<br/>timeouts, retention, payouts]
  end

  subgraph Data
    PG[(PostgreSQL + PostGIS<br/>primary + replica)]
    RD[(Redis/Valkey<br/>rate limits, call state, locks)]
    S3[(Object storage<br/>quarantine + clean buckets)]
    KMS[KMS + Secrets Manager]
    DWH[(Analytics store<br/>pseudonymised)]
  end

  subgraph External
    PA[Payment aggregator<br/>UPI, cards, payouts]
    FCM[FCM push]
    SMS[SMS (DLT) / WhatsApp BSP]
    MAPS[Maps / geocoding]
    BGV[KYC / BGV vendors]
    LLM[AI providers<br/>STT/TTS/LLM]
  end

  CPWA --> CDN --> API
  TAPP --> CDN
  ADM --> ZT --> ADMAPI
  BP <--> EXO
  EXO -- signed webhooks --> HOOKS
  HOOKS --> VOICE
  WA --> HOOKS
  PA -- signed webhooks --> HOOKS
  API & ADMAPI & HOOKS & VOICE & WORK & SCHED --> PG
  API & VOICE & WORK --> RD
  WORK --> PA & FCM & SMS & EXO & MAPS & BGV & LLM
  API --> S3
  App --> KMS
  PG -- CDC/ETL, PII stripped --> DWH
```

**Process roles** (same container image, different entrypoint and IAM role):
- `api`: public customer/technician API. Stateless. Autoscaled.
- `admin-api`: only reachable through the zero-trust proxy, on a separate domain, never on the public load balancer.
- `webhook`: receives third-party callbacks. Verifies signatures, persists the raw event idempotently, acknowledges fast, processes asynchronously.
- `voice`: low-latency IVR responses (the provider expects responses in under ~1–2 s). Isolated so a slow API deploy can't break live calls.
- `worker` / `scheduler`: background processing, outbox relay, timers (offer expiry, waiting fees, payout runs, retention).

### 7.4 Inter-module communication rules

- **Commands** (synchronous, in-process): `jobs.cancel(jobId, actor, reason)`. Called through the module facade, never through its repository.
- **Domain events** (asynchronous, durable): `JobRequested`, `OfferAccepted`, `DiagnosisSubmitted`, `QuoteApproved`, `WorkCompleted`, `PaymentCaptured`, `RefundIssued`, `WarrantyClaimOpened`, `SafetyIncidentRaised`… They are written to `outbox` **in the same DB transaction** as the state change and relayed to subscribers by the worker. At-least-once delivery means **every consumer is idempotent** (it stores processed event IDs).
- **Read models:** a module needing another's data for display (e.g., the admin job view) uses a facade query or a projection built from events, never a cross-schema join in application code. (Reporting uses the analytics store.)

### 7.5 Job orchestration

`jobs` owns the lifecycle state machine. Long-running flows (matching cascade → offer timeouts → re-match; quote approval reminders; payment pending → reminders → dispute) are implemented as **explicit, persisted workflows**: state rows plus scheduled timers in the job queue. They are not in-memory timers, so a process restart never loses an offer timeout.

(Evaluate Temporal in Phase 1 review only if workflow complexity grows. Not needed for V1.)

### 7.6 Reliability patterns

| Concern | Design |
|---|---|
| **Duplicate taps / retries** | Every mutating API call needs an `Idempotency-Key` (client-generated UUID, created when the screen opens, not when tapped). Stored in `idempotency_keys(actor_id, key, request_hash, response, expires_at)` with a unique constraint. Same key + same body returns the stored response. Same key + different body returns 422. **Plus a business-level duplicate check** (soft, not a hard constraint, because two separate plumbing problems at one address are legitimate): if an open job exists for the same (customer, address, service_type), the API returns `409 POSSIBLE_DUPLICATE`. The UI then asks "You already have a plumbing booking here. Add to it, or book a separate visit?", and a second confirmed submit sets `confirm_separate=true`. The button is also disabled on tap and shows progress. |
| **Offline technician app** | Actions (arrived, completed, cash collected) are queued locally with idempotency keys and client timestamps, then replayed in order. The server is authoritative and may reject with an explanation (e.g., the job was cancelled meanwhile). |
| **Webhooks (payments, telephony, WhatsApp)** | Verify signature → insert raw event with a unique `(provider, provider_event_id)` → 200 OK → process asynchronously. Out-of-order events are handled by state-machine guards (ignore "payment.authorized" after "payment.captured"). |
| **Payments** | Never trust client success. Server verification plus webhook. A **daily reconciliation** job compares PA settlement reports with the ledger; mismatches go to a finance queue. Refunds are idempotent by refund request ID. |
| **External calls** | Timeouts on every call. Retries with exponential backoff and jitter (only for idempotent operations). Circuit breakers per provider. **Fallback chains** (push → SMS → IVR call; primary SMS provider → secondary). |
| **Technician call failures** | Up to N attempts → next candidate → ops alert if the cascade is exhausted. Call outcome events are idempotent per provider call SID. |
| **Queues** | Postgres-backed queue (transactional enqueue). Retry policy per job type. **Dead-letter** table plus an admin view with replay. Poison-message detection. |
| **Database failure** | Managed Postgres Multi-AZ (automatic failover ~1–2 min). Apps reconnect with backoff. Read-only degradation mode (customers can view status; writes show "try again"). PITR backups. |
| **Third-party outage** | Feature-level degradation: maps down → locality search without map; AI down → manual category selection; telephony down → secondary provider for critical flows, SMS fallback, ops desk callouts. |
| **Eventual consistency (accepted)** | Notifications, analytics, ratings aggregates, matching stats (recomputed), search projections. |
| **Strong consistency (required)** | Job state transitions, quote approval, ledger entries, payment state, assignment (one technician per active assignment, enforced by a unique partial index plus row lock). |
| **Concurrency** | Offer acceptance uses `SELECT … FOR UPDATE` on the job/offer plus the state guard: the first valid accept wins, and later accepts get "This job was taken". Optimistic locking (`version` column) on editable aggregates. |

---

## 8. Recommended technology stack

Selection criteria: maturity, security track record, hiring pool in India, low ops burden, cost, and fit for low-end devices and networks.

| Layer | Choice | Why | Alternatives considered |
|---|---|---|---|
| **Language (backend)** | **TypeScript on Node.js (LTS)** | One language across backend, PWA, technician app and admin means shared validation schemas and API types, and a smaller team covers more. Large Indian hiring pool. Excellent I/O concurrency for webhook- and telephony-heavy workloads. | **Kotlin + Spring Boot (Spring Modulith)** is a strong runner-up: more robust typing and built-in modulith verification, but slower iteration and two languages. **Python/Django**: great admin and ORM, but weaker static typing and a second language. **Go**: great runtime, thinner ecosystem for this domain. |
| **Backend framework** | **NestJS** | DI and module system map directly to bounded contexts. Guards/interceptors suit centralized authZ, validation and idempotency. Mature. | Fastify-only (less structure), Express (too bare). |
| **Validation** | **Zod** schemas shared between client and server; OpenAPI generated from them | Single source of truth. Prevents mass-assignment (explicit schemas). | class-validator (decorator-heavy, weaker type inference). |
| **DB access** | **Drizzle ORM** plus hand-reviewed SQL migrations | Typed queries, close to SQL, full Postgres feature access (partial indexes, CHECKs, RLS, PostGIS through raw SQL). Migrations are plain SQL in review. | Prisma (heavier abstraction, weaker for advanced constraints), Kysely (also good; a valid swap). |
| **Database** | **PostgreSQL 17 + PostGIS** (managed: AWS RDS Multi-AZ) | ACID, mature, rich constraints, JSONB for snapshots, PostGIS for zones/distance, partitioning for append-only tables. | MySQL (weaker constraint/GIS story), MongoDB (wrong fit for a ledger and transactional workflows). |
| **Cache / ephemeral state** | **Redis-compatible (ElastiCache Valkey)** | Rate-limit counters, OTP attempt counters, IVR call session state, distributed locks, short-TTL caches. **Never the system of record.** | — |
| **Queue / jobs** | **Postgres-backed queue (Graphile Worker or pg-boss) + transactional outbox** | Enqueue happens in the same transaction as the business write, so there are no lost or phantom jobs. One less system to operate. Comfortably handles thousands of jobs/sec. | SQS (add for cross-system fan-out later), Kafka (overkill now), BullMQ (Redis durability concerns for money flows). |
| **Object storage** | **S3** (ap-south-1), private buckets, quarantine → clean flow, SSE-KMS | Presigned uploads keep large files off API servers. Lifecycle rules handle retention. | — |
| **Search** | **Postgres** (trigram + full-text) for admin search and locality lookup | No extra system until data proves the need. | OpenSearch later for analytics/log search. |
| **Customer frontend** | **Next.js (React) PWA**, server-rendered, strict performance budget (initial JS ≤ 150 KB gz, LCP < 2.5 s on throttled 3G/low-end device) | SSR gives fast first paint on slow networks. PWA is installable without the Play Store and uses little storage. Workbox offline shell. i18n via ICU messages. | Plain React SPA (slow first paint), native app (install friction for V1). |
| **Technician app** | **React Native (Expo, Hermes), Android-first, minSdk 26 (Android 8)** with SQLite offline queue, FCM, Play Integrity | Shares TS models with the backend. Hermes keeps memory and startup acceptable on 2–3 GB devices. Expo speeds builds/updates. **Gate:** Phase 6 starts with a 1-week spike on 3 real low-end devices (e.g., ₹6–9k phones). If cold start is > 4 s or the APK is > 30 MB, switch to **Kotlin native (Jetpack Compose)**. | Kotlin native (best perf, smallest APK, second codebase), Flutter (good perf, new language), PWA (unreliable background push and full-screen alerts on Android). |
| **Admin console** | **React + Vite SPA** (or Next.js) on an internal domain, behind a zero-trust proxy | Rich tables/forms. Separate build and deployment from customer surfaces. | Retool-style internal tools (vendor lock-in, PII exposure to a SaaS). |
| **Telephony / IVR / masking** | **Exotel** (primary), behind a `TelephonyPort`; secondary such as **Ozonetel or Knowlarity** for failover | Indian telecom-compliant providers with virtual numbers, IVR flows, call bridging (number masking), recordings and Indian data centres. International CPaaS (e.g., Twilio) has limited Indian number and IVR support due to DoT rules. | Plivo (India support varies by feature; evaluate). |
| **SMS** | DLT-registered provider (e.g., **MSG91 / Gupshup / Exotel SMS**), two providers for failover | TRAI TCCCPR requires DLT registration of entity, headers and templates. | — |
| **WhatsApp** | **WhatsApp Business Platform** (Cloud API or via BSP) | Dominant channel in Tier-2/3. Approved templates for updates. Opt-in tracked. | — |
| **Push** | **FCM** (high-priority data messages for offers) | Standard on Android. Free. | — |
| **Payments** | **Razorpay** or **Cashfree** (RBI-authorised PA), using UPI-first checkout, payment links, a **marketplace split-settlement** product (Razorpay Route / Cashfree Easy Split) and a **payouts** product | Licensed PA handles escrow/nodal flows required for marketplaces. UPI dominates Tier-2/3. Payouts API with penny-drop. **Pick one primary after commercial evaluation; keep `PaymentPort` abstract.** | Juspay (orchestrator, more for scale), PayU. |
| **Maps / geocoding** | **Mappls (MapmyIndia)** or **Google Maps Platform**, behind `GeoPort`; store **DIGIPIN** when available | Mappls has strong Indian address/locality data and Indian data residency. Google has the best POI coverage. Decide after a geocoding-accuracy test on 200 real pilot-city addresses. Ola Maps is a cost-effective alternative. | — |
| **Indic speech (STT/TTS)** | Evaluate **Sarvam AI**, **Bhashini** (Govt. of India ULCA), **Google Cloud Speech (Chirp)**, AI4Bharat open models; behind `SpeechPort` | Hindi + regional-language accuracy on *phone-quality (8 kHz) audio* matters more than benchmarks. Decide by an eval on recorded pilot-city samples. Pre-recorded human prompts for fixed IVR text. | — |
| **LLM** | **Claude** (Haiku 5.5 for high-volume classification and redaction-checked summarisation; Sonnet 5.5 for complex ops assistance), behind `LlmPort`, with **India-region inference preferred** (e.g., via a cloud provider's Mumbai region if available) | Strong structured-output reliability and multilingual ability. Abstraction allows swapping. **Data residency must be confirmed before production PII flows.** | Other providers via the same port. |
| **KYC / BGV** | Licensed vendors (e.g., IDfy, AuthBridge, OnGrid), behind `VerificationPort`; **DigiLocker** for document pull | Regulated handling of Aadhaar/ID verification. We store results, not raw ID numbers. | — |
| **Cloud** | **AWS ap-south-1 (Mumbai)** primary; **ap-south-2 (Hyderabad)** for DR backups | Mature managed services in India. Data residency simplifies CERT-In and DPDP posture. Startup credits available. | GCP Mumbai/Delhi (equally viable), Azure India. |
| **Compute** | **ECS on Fargate** | No cluster management. Per-role services. Good enough for years. | EKS (Kubernetes ops overhead not justified yet). |
| **IaC** | **Terraform/OpenTofu** | Reviewable infra changes, reproducible environments. | CDK. |
| **CI/CD** | **GitHub Actions** with **OIDC** to AWS (no long-lived cloud keys), required reviews, protected branches; **EAS Build** for the app | Standard and auditable. | — |
| **Edge / WAF** | **CloudFront + AWS WAF** (or Cloudflare) | DDoS protection, bot rules, geo/rate rules, TLS. | — |
| **Zero-trust admin access** | **Cloudflare Access** or **AWS Verified Access**, with Google Workspace/Entra SSO + **phishing-resistant MFA (passkeys/security keys)** | Admin never exposed on the open internet without identity-aware proxying. | VPN (weaker, clunky). |
| **Secrets / keys** | **AWS Secrets Manager + KMS** (separate CMKs per data class) | Rotation, audit, IAM-scoped. | Vault (more ops). |
| **Observability** | **OpenTelemetry** SDKs → traces/metrics/logs; **Grafana stack (Loki/Tempo/Prometheus-compatible)** or CloudWatch; **Sentry** for errors (PII scrubbing on, self-hosted or region-verified) | Vendor-neutral instrumentation. **Authoritative logs stored in India for ≥180 days (CERT-In).** | Datadog (cost at scale; data residency check). |
| **Feature flags** | DB-backed `config` module first; **Unleash (self-hosted)** or GrowthBook if needed | Kill switches for AI, providers and features. No PII to a SaaS. | LaunchDarkly (cost, data export). |
| **Security tooling** | Semgrep (SAST), GitHub Dependabot/OSV-Scanner (SCA), gitleaks (secrets), Trivy (images/IaC), OWASP ZAP (DAST), MobSF (mobile) | Shift-left in CI. Free/cheap tools that are well understood. | — |
| **Analytics** | Pseudonymised event stream → **ClickHouse** or **BigQuery-equivalent in India region**; Metabase for internal BI (behind SSO) | Product/ops analytics without production PII. | — |

---

## 9. Database / entity overview

Full DDL is Phase 2. This section sets **conventions, entities, relationships, constraints and data-protection rules**.

### 9.1 Conventions

| Topic | Rule |
|---|---|
| **Primary keys** | `uuid` **v7** (time-ordered; index-friendly; non-guessable enough with authZ checks; safe to expose). Never expose sequential integers. |
| **Human/IVR references** | `jobs.public_ref` like `HF-7K3P9Q` (Crockford Base32, no ambiguous characters) for chat/phone support, **plus** `jobs.ivr_code`: a 4–6 digit numeric code unique among *active* jobs per technician (partial unique index), for keypad entry. Never used for authorization alone. |
| **Foreign keys** | Always declared within a module schema. `ON DELETE RESTRICT` by default (records are never hard-deleted through cascades). Cross-module references are plain `uuid` columns with application-level integrity and a nightly orphan check, except `identity.users`. |
| **Money** | `bigint` **paise** plus a `currency char(3) DEFAULT 'INR'`. Never floats. Rounding rules live in the pricing module (half-up to paise, rupee rounding only at display/invoice per GST rules). |
| **Time** | `timestamptz` in UTC. Display in IST. Business dates (`service_date`) as `date` with the city timezone. |
| **Enums** | Postgres `text` + `CHECK` constraints or lookup tables for anything admins may extend (categories, reasons). Hard enums only for state machines. |
| **Optimistic locking** | `version int` on mutable aggregates (jobs, profiles, rate cards in draft). |
| **Standard columns** | `created_at`, `created_by` (actor id), `updated_at`, `updated_by`. `deleted_at` only where soft-delete applies. |
| **Multi-city** | Every operational row carries `city_id` (and `zone_id` where relevant). This enables row-level partitioning/sharding by region later and per-city RBAC scoping. |
| **Naming** | snake_case. Plural tables. Schema per module. |
| **JSONB** | Only for **immutable snapshots** (price snapshot, policy snapshot, provider raw payloads) and flexible attributes behind a JSON schema. Never for data we filter or join on routinely. |

### 9.2 Entities by module

Legend: 🔐 = contains PII (encrypted fields), ⛓ = append-only, 📸 = immutable after finalisation.

**identity**
- `users`: id, `phone_e164_enc` 🔐, `phone_hash` (HMAC-SHA256 with a pepper, for lookup; unique), `phone_last4`, preferred_language, status (`active/suspended/deleted`), created_at, `deleted_at`. *The identity of a person. A user may have both a customer and a technician profile.*
- `devices`: id, user_id, platform, app_version, push_token_enc, attestation_status, last_seen_at.
- `refresh_tokens`: id, user_id, device_id, `token_hash`, family_id (for rotation and reuse detection), expires_at, revoked_at.
- `otp_challenges`: id, `phone_hash`, purpose, `code_hash`, attempts, expires_at, consumed_at, ip_hash. TTL purge ≤ 24 h.
- `ivr_credentials`: user_id, `pin_hash` (Argon2id), failed_attempts, locked_until.

**customers**
- `customer_profiles`: user_id (PK/FK), `display_name_enc` 🔐, `gender_self_declared` (nullable, consent-gated, Restricted), marketing_opt_in.
- `addresses` 🔐: id, user_id, label, `line1_enc`, `line2_enc`, `landmark_enc`, locality_id, city_id, `geo_point` (rounded to ~10 m for operations; exact point encrypted), `digipin`, `deleted_at` (soft delete; jobs keep their own snapshot).

**workforce**
- `technician_profiles`: user_id, `legal_name_enc` 🔐, display_name (first name + initial), photo_file_id, device_mode (`smartphone/basic_phone/agent_assisted`), onboarding_status, verification_level, languages[], experience_years, home_locality_id, status (`probation/active/paused/suspended/offboarded`), `gender_self_declared` (Restricted; used only for opt-in matching such as Care Visit), dob_year (18+ check; we don't store the full DOB unless needed).
- `technician_skills`: technician_id, service_type_id, specialization_id, level (`claimed/assessed/certified`), verified_by, verified_at. Unique (technician_id, service_type_id, specialization_id).
- `technician_service_areas`: technician_id, locality_id or zone_id, priority (`primary/secondary`), max_radius_km. Unique (technician_id, locality_id).
- `technician_availability`: weekly schedule rows (weekday, start_time, end_time) plus `availability_overrides` (date ranges, leave).
- `technician_daily_checkins` ⛓: technician_id, date, available bool, locality_id, channel (`app/ivr/missed_call/agent`), created_at.
- `technician_location_pings`: **only** one-time consented "share now" pings and arrival snapshots. Retention ≤ 30 days. No continuous tracking.
- `technician_metrics` (derived, recomputed): acceptance_rate, on_time_rate, no_show_rate, upheld_complaint_rate, rating_bayes, jobs_completed, last_active. Windows: 30 d / 90 d / lifetime.
- `payout_methods` 🔐: technician_id, type (`bank/upi`), `account_number_enc`, `ifsc`, `vpa_enc`, `holder_name_enc`, penny_drop_status, name_match_score, active_from (cooling-off), status.
- `field_agents`: user_id, agent_code, city_id, status, contract_ref.
- `agent_technician_links`: agent_id, technician_id, role, valid_from, valid_to.

**verification**
- `documents` 🔐: id, owner_user_id, type, file_id, `doc_number_masked` (never the full Aadhaar), uploaded_by, status, expires_at, retention_until.
- `verification_records` ⛓: id, subject_user_id, type (`identity/address/background/skill/bank`), vendor, vendor_ref, result (`pass/fail/inconclusive/expired`), result_summary (minimised), decided_by, decided_at, valid_until.

**catalog**
- `service_categories`, `service_types`, `specializations`: translations via `*_i18n` tables (locale, name, description), `is_active`, sort order.
- `symptoms`: customer-facing chips, mapped to service types.
- `repair_catalog_items`: code, service_type_id, required_specialization_id, default_labour_paise (via rate card), warranty_policy_id, `keypad_code` (for IVR), i18n names.
- `materials`: code, name i18n, unit, category.
- `material_reference_prices`: material_id, city_id, price_paise, effective_from, source.
- `service_type_rules`: attributes for future categories (`requires_worker_gender`, `max_duration_minutes`, `scope_checklist`, `min_verification_level`). **This is the Care Visit placeholder.**

**pricing** (all effective-dated, versioned, approval-gated)
- `rate_cards`: id, city_id, version, status (`draft/pending_approval/active/retired`), effective_from, effective_to, approved_by, approved_at. Exclusion constraint: no overlapping active cards per city.
- `rate_card_items`: rate_card_id, repair_catalog_item_id or service_type_id, labour_paise, min_paise, max_paise, technician_share_bps.
- `fee_rules`: rate_card_id, type (`visit_fee/platform_fee/material_markup/cancellation/waiting/travel_comp`), calc (`flat/percent/tiered`), params JSONB (schema-validated), conditions.
- `commission_rules`: rate_card_id, scope, bps, min/max.
- `price_snapshots` 📸: id, job_id, rate_card_id, rule_versions JSONB, computed_lines JSONB, hash.

**jobs**
- `jobs`: id, public_ref, ivr_code, customer_user_id, city_id, zone_id, service_type_id, symptom_ids[], `problem_text_enc` 🔐, voice_note_file_id, address_id, `address_snapshot_enc` 🔐 (copied at booking), locality_id, requested_window (tstzrange), urgency, channel, status, `warranty_parent_job_id`, `client_request_id` (unique per customer), version, timestamps.
- `job_status_history` ⛓ (partitioned monthly): job_id, from_status, to_status, actor_type, actor_id, channel, reason_code, metadata, created_at.
- `visits`: id, job_id, purpose (`diagnosis/repair/warranty`), technician_id, departed_at, arrived_at (start-code verified), completed_at, `start_code_hash`, `completion_code_hash`, waiting_started_at.
- `assignments`: id, job_id, visit_id, technician_id, role (`diagnosis/repair`), status (`active/released/cancelled/completed`), assigned_via (`offer/manual`), assigned_by. **Partial unique index:** one `active` assignment per (job_id, role).
- `cancellations`: job_id, cancelled_by_type, reason_code, stage, fee_paise, compensation_paise, policy_snapshot.

**matching**
- `match_runs`: id, job_id, config_version, started_at, outcome.
- `match_candidates`: match_run_id, technician_id, eligible, exclusion_reason, score, score_breakdown JSONB, rank.
- `offers`: id, job_id, technician_id, match_run_id, channel (`push/ivr`), sent_at, expires_at, responded_at, response (`accepted/rejected/expired/unreachable/superseded`), reject_reason. Unique (job_id, technician_id, match_run_id).

**diagnosis**
- `diagnoses` 📸 (after submission): id, job_id, visit_id, technician_id, captured_by (tech or agent), problem_category_id, observed_issue (text + chips), severity, recommended_action, notes, photo_file_ids[], submitted_at.
- `quotes` 📸: id, job_id, diagnosis_id, **version** (unique per job), status (`pending/approved/rejected/superseded/expired`), subtotal/total/tax fields (paise), price_snapshot_id, `content_hash`, created_by. Partial unique: only one `approved` non-superseded quote per job at a time.
- `quote_items` 📸: quote_id, type (`labour/material/visit_fee/adjustment/platform_fee/tax`), repair_catalog_item_id, material_id, description_i18n, qty, unit_price_paise, amount_paise, reference_price_paise, deviation_reason.
- `quote_approvals` ⛓: quote_id, decision, channel (`app/link/ivr/agent_recorded_call`), actor_user_id, device_id/call_session_id, quote_content_hash, decided_at.
- `material_usage`: job_id, quote_item_id, material_id, qty_used, actual_cost_paise, receipt_file_id.

**payments** (double-entry)
- `ledger_accounts`: id, owner_type (`platform/technician/customer_receivable/pa_clearing/tax_payable…`), owner_id, currency.
- `ledger_transactions` ⛓: id, type, reference_type/id, created_at, idempotency_key (unique).
- `ledger_entries` ⛓: transaction_id, account_id, amount_paise (signed), with a **deferred constraint** that each transaction sums to zero.
- `payment_intents`: id, job_id, amount, provider, provider_order_id, status, idempotency_key.
- `payments`: id, intent_id, provider_payment_id (unique), method (`upi/card/netbanking/cash`), status, captured_at, raw_event_id.
- `cash_collections`: job_id, technician_id, amount, customer_confirmation (`confirmed/disputed/pending`), confirmed_via.
- `refunds`: id, payment_id, amount, reason_code, status, provider_refund_id (unique), requested_by, approved_by.
- `payouts`: id, technician_id, period, gross, deductions, net, status, provider_payout_id (unique), payout_method_id.
- `invoices` 📸: id, number (sequential **per GSTIN per financial year**, gapless where required), job_id, issuer, line snapshot, tax breakdown, pdf_file_id.
- `provider_events` ⛓: provider, event_id (unique per provider), type, payload (encrypted if it contains PII), received_at, processed_at.

**warranty**
- `warranty_policies`: id, service_type_id/repair_catalog_item_id, duration_days, coverage_rules JSONB, revisit_fee_waived, cost_bearer (`technician/platform/split`), version, status, effective dates.
- `warranty_coverages` 📸: id, job_id, policy_id, policy_version, starts_at, ends_at, covered_item_ids[].
- `warranty_claims`: id, coverage_id, original_job_id, new_job_id, status (`submitted/eligible/ineligible/in_review/resolved/disputed`), decision_reason, decided_by.

**trust**
- `ratings`: id, job_id, rater_user_id, ratee_user_id, direction (`customer_to_tech/tech_to_customer`), stars, tags[], `is_visible`. Unique (job_id, direction).
- `reviews`: rating_id, text (moderation status). Not publicly displayed in V1.
- `complaints`: id, job_id (nullable), raised_by, against_user_id, category, severity, description_enc 🔐, attachments, status, sla_due_at, assignee_admin_id.
- `disputes`: id, type (`price/quality/payment/warranty/cancellation/conduct`), job_id, parties, status, outcome, financial_adjustment_txn_id, appeal_of_dispute_id.
- `investigation_notes` ⛓: dispute_or_complaint_id, author_admin_id, note_enc 🔐, visibility.
- `sanctions`: technician_id/customer_id, type (`warning/coaching/suspension/deactivation`), reason, linked_dispute_id, approved_by, starts/ends, appeal_status.
- `safety_incidents` 🔐: id, job_id, raised_by, channel, severity, status, location_snapshot_enc, handled_by, timeline JSONB, police_ref_enc.
- `fraud_signals`: subject_type/id, signal_type, score, evidence_refs, status.
- `blocks`: blocker_user_id, blocked_user_id, reason. Excluded from matching.

**voice / comms**
- `call_sessions`: id, provider, provider_call_id (unique), direction, purpose (`offer/checkin/approval/masked_bridge/sos/support`), `from_hash`, `to_hash`, job_id, technician_id, status, duration, cost_paise, recording_file_id (nullable).
- `ivr_interactions` ⛓ (partitioned): call_session_id, step, prompt_id, input_type (`dtmf/speech/timeout`), input_value (**never** OTPs/PINs; stored as `***`), asr_confidence, created_at.
- `masked_number_bindings`: virtual_number, party_a_hash, party_b_hash, job_id, valid_from, valid_until.
- `notifications`: id, user_id, template_id, channel, status, provider_msg_id, attempts, payload_ref (no PII in payload where possible).
- `notification_templates`: key, channel, locale, body, `dlt_template_id`, whatsapp_template_name, version.

**backoffice / compliance**
- `admin_users`: id, sso_subject, email, status, last_login. **Separate from `users`.**
- `roles`, `permissions`, `role_permissions`, `admin_role_grants` (with scope: city_id/zone_id, granted_by, expires_at).
- `approval_requests` (maker-checker): action_type, payload_hash, requested_by, approved_by, status. Constraint: requester ≠ approver.
- `pii_access_events` ⛓: admin_id, subject_user_id, field, reason, ticket_ref, at.
- `audit_logs` ⛓ (partitioned monthly; hash-chained): id, at, actor_type, actor_id, action, resource_type, resource_id, before_hash/after_diff (PII-redacted), ip_hash, user_agent_hash, request_id, `prev_hash`, `hash`.
- `consents` / `consent_events` ⛓: user_id, purpose (`service_delivery/call_recording/marketing/location_once/gender_stats/bgv`), notice_version, language, granted/withdrawn, channel, proof (OTP id / call recording ref).
- `data_rights_requests`: id, user_id, type (`access/correction/erasure/grievance/nomination`), status, due_at, resolution, executed_actions JSONB.
- `retention_policies`: data_class, retention_period, legal_basis, action (`delete/anonymise/archive`).

**infrastructure tables**
- `outbox`, `processed_events` (consumer, event_id unique), `idempotency_keys`, `job_queue` (library-managed), `dead_letters`.

**benefits (skeleton)**
- `benefit_programs` (partner, type, eligibility rules), `benefit_enrollments` (technician, program, consent_id, partner_ref, status). **No money tables.**

### 9.3 Key constraints (illustrative; final DDL in Phase 2)

```sql
-- One active assignment per job role
CREATE UNIQUE INDEX uq_assignment_active ON jobs.assignments (job_id, role) WHERE status = 'active';

-- Supports the soft duplicate-booking check (409 POSSIBLE_DUPLICATE), not a hard uniqueness rule
CREATE INDEX ix_open_job ON jobs.jobs (customer_user_id, address_id, service_type_id)
  WHERE status IN ('REQUESTED','MATCHING','ASSIGNED','EN_ROUTE');

-- Idempotent booking: hard guarantee against double-taps/retries
CREATE UNIQUE INDEX uq_job_client_req ON jobs.jobs (customer_user_id, client_request_id);

-- Quote versions are monotonic per job; at most one approved at a time
CREATE UNIQUE INDEX uq_quote_version ON diagnosis.quotes (job_id, version);
CREATE UNIQUE INDEX uq_quote_approved ON diagnosis.quotes (job_id) WHERE status = 'approved';

-- Approved quotes and their items are immutable (trigger rejects UPDATE/DELETE once approved)
-- Ledger: deferred trigger asserts SUM(amount_paise) = 0 per transaction
-- Pricing: no overlapping active rate cards per city
ALTER TABLE pricing.rate_cards ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (city_id WITH =, tstzrange(effective_from, effective_to) WITH &&)
  WHERE (status = 'active');

-- Money is never negative where it shouldn't be
ALTER TABLE diagnosis.quote_items ADD CHECK (qty > 0 AND unit_price_paise >= 0);

-- Maker-checker
ALTER TABLE backoffice.approval_requests ADD CHECK (approved_by IS NULL OR approved_by <> requested_by);
```

Also: the invoice total must equal the latest approved quote total plus approved adjustments (checked in a transaction and by a nightly integrity job). The `cash_collections.amount` mismatch rule raises a dispute.

### 9.4 Indexes (initial set)

- Lookups: `users(phone_hash)` unique; `jobs(public_ref)` unique; `jobs(ivr_code, technician)` partial on active.
- Work queues: `jobs(city_id, status, created_at)`; `offers(technician_id, response) WHERE response IS NULL`; `complaints(status, sla_due_at)`; `disputes(status, assignee)`.
- Matching: `technician_service_areas(locality_id)`; `technician_skills(service_type_id, specialization_id)`; `technician_daily_checkins(date, locality_id) WHERE available`; GiST on `zones.polygon` and `localities.centroid`.
- History: `job_status_history(job_id, created_at)`; `audit_logs(resource_type, resource_id, at)`; BRIN on `at` for large partitioned tables.
- Provider idempotency: unique `(provider, provider_event_id)`, `(provider, provider_payment_id)`, `(provider, provider_call_id)`.
- Every FK column is indexed. Index review is part of Phase 2 using `EXPLAIN` on the top 30 queries.

### 9.5 Soft deletion policy

| Data | Approach |
|---|---|
| Catalog, rate cards, policies, zones | **Never deleted.** `status=retired` plus effective dates (history must remain valid). |
| Addresses | `deleted_at` soft delete (jobs keep their own encrypted snapshot). |
| Users (account deletion) | **Not soft delete.** PII is **erased/anonymised** (see 11.6). The row stays as a tombstone (`status=deleted`, PII nulled, crypto key destroyed) so financial and audit references stay intact. |
| Jobs, quotes, payments, ledger, audit, status history | **Never deleted** within the legal retention window. Corrections are made through new rows (reversals/adjustments). |
| OTPs, idempotency keys, sessions, location pings | **Hard-deleted** by TTL jobs. |

Soft-deleted rows are excluded through views/repository defaults. Unique indexes are partial on `deleted_at IS NULL`.

### 9.6 Auditability

- **Business history:** `job_status_history`, `quote_approvals`, `ledger_*`, `verification_records`, `consent_events` (all append-only; app DB role has INSERT/SELECT only and no UPDATE/DELETE; enforced by grants plus triggers).
- **Security/admin audit:** `audit_logs` for every admin action, every PII reveal, every role/permission change, every config/pricing change, every auth event (login, OTP failures, token reuse detection). Hash-chained per partition. Daily anchor hash exported to WORM storage (S3 Object Lock).
- **Request correlation:** every row written in a request carries a `request_id` that links to traces and logs.

### 9.7 Data retention (proposed; **legal review required**)

| Data class | Retention | Basis / note |
|---|---|---|
| Financial records (invoices, ledger, payments, payouts) | 8 years from FY end | Companies Act s.128 books of account; GST records (min. 72 months from annual return due date). PII minimised and pseudonymised after closure. |
| Job records (operational) | Active + 3 years, then anonymise | Disputes, warranty, legal claims (limitation period). |
| Diagnosis/quote/approval proofs | Same as job, or longer if linked to a dispute | Evidence. |
| Call recordings (when consented) | 90 days default, extended only if linked to an open complaint/safety case | Minimisation. |
| IVR interaction logs | 1 year (DPDP Rules log-retention requirement; verify) | — |
| Security/access logs, audit logs | ≥ 1 year online (DPDP Rules), ≥ 180 days in India (CERT-In 2022 Directions); audit logs 3–8 years | — |
| OTP challenges | ≤ 24 h | — |
| KYC/BGV documents (images) | Until verification + N days, then delete. Keep only the result record for the engagement period + 3 years | Minimisation. |
| Technician location pings | ≤ 30 days | — |
| Safety incidents | 8 years (legal exposure) | Restricted access. |
| Marketing consent records | Life of consent + 3 years | Proof of consent. |
| Inactive customer accounts | Notify, then erase PII after 3 years of inactivity (aligned to DPDP Rules for large e-commerce/intermediary classes; confirm applicability) | — |

### 9.8 Encryption requirements

| Layer | Requirement |
|---|---|
| In transit | TLS 1.2+ (1.3 preferred), HSTS (preload), TLS to DB/Redis, certificate pinning considered for the technician app (with a rotation plan). Webhooks need HTTPS plus signature. |
| At rest (infra) | RDS/EBS/S3/backups encrypted with **KMS CMKs** (separate keys: `db`, `files-kyc`, `files-general`, `backups`, `logs`). |
| Application-level field encryption | 🔐 fields encrypted with **AES-256-GCM** using **envelope encryption**. Data keys come from KMS and are cached briefly in memory. Key ID is stored with the ciphertext for rotation. |
| Crypto-shredding | Customer and technician PII uses a **per-subject data key** (wrapped by KMS, stored in `identity.subject_keys`). Erasure destroys the subject key, so the PII becomes unreadable **including in backups**. |
| Lookup without decryption | Phone numbers and other searchable identifiers get **HMAC-SHA256 blind indexes** with a secret pepper in Secrets Manager. Masked versions (`+91 98•••••21`) are stored for display. |
| Passwords/PINs | **Argon2id** (memory-hard; tuned params). Customers and technicians have no passwords at all. IVR PINs: Argon2id + lockout. |
| Key rotation | KMS automatic annual rotation. Data-key re-wrap job. Pepper rotation through a dual-HMAC transition. |

### 9.9 PII handling rules

1. **Classification:** each column is tagged `public / internal / confidential / restricted` in the schema registry (a lint check enforces tags on new columns).
2. **Minimisation:** we don't collect DOB (only an 18+ assertion and birth year for technicians), father's name, caste, religion or full Aadhaar. Gender is optional, purpose-bound and consent-gated.
3. **Separation:** operational tables reference `user_id`. PII lives in a small number of encrypted columns. Analytics gets only pseudonymous IDs (keyed hash, rotated per export domain).
4. **Lower environments:** **never** contain production PII. Synthetic data generators are used instead.
5. **Exposure by role and stage:** see 11.3.
