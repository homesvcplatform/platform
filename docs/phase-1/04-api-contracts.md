# Phase 1 · 04 — V1 REST API Contracts

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Contracts are written as Zod schemas in Phase 2 and published as OpenAPI 3.1. This document is the normative V1 design. **No endpoint returns database rows.** Every response is a purpose-built DTO for a specific actor surface.

---

## 1. Conventions

### 1.1 Surfaces & hosts

| Surface | Host / prefix | Actors | Auth |
|---|---|---|---|
| Customer & technician & agent | `api.<domain>/v1/...` | CUS, TEC, AGT | Bearer access token (**technician app only**) or session cookie via `web-bff` (PWA **and field-agent web**, SR-02) |
| Public signed links | `api.<domain>/v1/links/...` | link holder + OTP | Link token + OTP |
| Admin | `admin.<internal>/admin/v1/...` | admin roles | Zero-trust proxy assertion + admin session |
| Webhooks | `hooks.<domain>/...` | providers | Provider signatures |

**Separate surfaces return separate DTOs**, so a technician endpoint physically cannot serialise customer-only fields.

**CORS (G-6/SR-11):** `api`, `admin-api` and `hooks` send **no CORS headers**, so cross-origin browser calls are denied. The PWA and field-agent web reach `api` only through the same-origin `web-bff`. The technician app doesn't need CORS.

### 1.2 Request/response rules
- JSON only, UTF-8, `camelCase`. Max body 64 KB (uploads go to S3 directly).
- **Unknown fields → 400** (`strict` schemas; mass-assignment protection).
- Money: `{ "amountPaise": 40000, "currency": "INR" }`. Times: RFC 3339 UTC. Windows: `{ "start": "...", "end": "..." }`.
- IDs are opaque strings. Clients must not parse them.
- Localised text: the server returns `labelKey` + `params` **and** a pre-rendered `label` in `Accept-Language` (clients may render either; IVR uses keys).
- Optimistic concurrency: mutable resources return `version`. Updates send `expectedVersion`. A mismatch returns `409 STALE_VERSION`.
- Pagination: cursor-based `?cursor=&limit=` (limit ≤ 50). Response `{ items, nextCursor }`.
- Minimum app version: header `X-Client-Version`. Below `min_supported` → `426 UPGRADE_REQUIRED` with store link.

### 1.3 Idempotency
- `Idempotency-Key: <uuid>` is **required** on every non-GET marked **Idem: required**. The client generates it **when the screen/action is prepared**, and reuses it for retries and offline replays.
- Same key + same body hash → the stored response is replayed (with header `Idempotent-Replay: true`). Same key + different body → `422 IDEMPOTENCY_KEY_REUSED`. Concurrent duplicate while in flight → `409 REQUEST_IN_PROGRESS` (client retries after `Retry-After`).
- Keys are retained 24 h by default, **7 days for technician-surface endpoints** (offline replays, X-20) and 72 h for payment endpoints. Visit actions are also state-idempotent (e.g., arrive when already ON_SITE → 200 no-op).

### 1.4 Error model (RFC 9457 `application/problem+json`)
```json
{ "type": "https://errors.<domain>/QUOTE_CHANGED", "status": 409, "code": "QUOTE_CHANGED",
  "title": "Quote has changed", "detailKey": "errors.quote_changed", "requestId": "…",
  "fields": [{ "path": "contentHash", "code": "MISMATCH" }] }
```
Common codes: `VALIDATION_FAILED`(400) · `UNAUTHENTICATED`(401) · `STEP_UP_REQUIRED`(401) · `FORBIDDEN`(403) · `NOT_FOUND`(404, **also used for objects that exist but the actor may not see**) · `STALE_VERSION`(409) · `INVALID_STATE`(409) · `POSSIBLE_DUPLICATE`(409) · `REQUEST_IN_PROGRESS`(409) · `IDEMPOTENCY_KEY_REUSED`(422) · `UPGRADE_REQUIRED`(426) · `RATE_LIMITED`(429 + `Retry-After`) · `PROVIDER_UNAVAILABLE`(503) · `INTERNAL`(500, no details).
Error messages never reveal whether a phone is registered, whether an object exists for another user, or internal identifiers.

### 1.5 Rate-limit classes (token bucket in Valkey; values configurable)

| Class | Default limits |
|---|---|
| `AUTH_OTP_SEND` | per phone 1/30 s, 5/h, 10/day · per IP 20/h · per device 10/h · global anomaly breaker |
| `AUTH_OTP_VERIFY` | 5 attempts/challenge · per IP 60/h |
| `READ` | 120/min per user |
| `WRITE` | 30/min per user |
| `CRITICAL` | 10/min per user (approve, accept, pay, codes, payout method) |
| `CODE_ENTRY` | 5 attempts per visit code, then locked |
| `UPLOAD` | 30/h per user, 200 MB/day |
| `LINK` | 10/min per link token + per IP 30/min |
| `SOS` | never rate-limited for a delivery; dedupe within 60 s |
| `ADMIN` | 120/min per admin · `ADMIN_REVEAL` 20/h per admin |

### 1.6 Audit
"Audit" lists the `compliance.audit_logs` action written in the same transaction. Every endpoint additionally emits structured access logs (no PII) and traces.

---

## 2. Shared DTOs

```ts
Money        = { amountPaise: int>=0, currency: "INR" }
TimeWindow   = { start: datetime, end: datetime }
LocalityRef  = { id, name: string }                       // localised
TechnicianCard = {                                         // public-safe
  ref: string,                                             // opaque per-job technician reference, not user id
  displayName: string, photoUrl?: signedUrl(5 min),
  badges: ("ID_VERIFIED"|"BACKGROUND_VERIFIED"|"SKILL_VERIFIED")[],
  rating?: { value: number(1dp), count: "5+"|"20+"|"50+"|"100+" },   // only if publishable
  segmentRating?: { segment: "WOMEN_CUSTOMERS", value: number }       // only if publishable (02 §6)
  languages: string[], jobsCompletedBucket: "NEW"|"10+"|"50+"|"200+",
  zonesServed: string[]                                    // zone names only, never localities (README C-15)
}
VisitSummaryForCustomer = {
  id, sequenceNo, purposes: ("DIAGNOSIS"|"REPAIR"|"WARRANTY_INSPECTION")[],
  status: "FINDING_TECHNICIAN"|"ASSIGNED"|"ON_THE_WAY"|"ARRIVED"|"WORKING"|"COMPLETED"|"CANCELLED"|"NEEDS_ATTENTION",
  window: TimeWindow, technician?: TechnicianCard,
  startCode?: string(4),          // only to the customer, only from ASSIGNED until ON_SITE
  completionCode?: string(4),     // only to the customer, only while IN_PROGRESS with REPAIR purpose
  canContactTechnician: boolean
}
```
Customer-facing statuses are **simplified projections** of internal states (internal names are never exposed).

---

## 3. Authentication & sessions

**POST `/v1/auth/otp/request`**: request a login/step-up OTP
- Actor: anonymous (login) / authenticated (step-up) · AuthN: none for LOGIN; bot signal (Turnstile token on web, Play Integrity token on app) · AuthZ: — · Rate: `AUTH_OTP_SEND` · Idem: not required · Audit: `auth.otp_requested` {phoneBidx, purpose, outcome}
- Req: `{ phone: /^\+91[6-9]\d{9}$/, purpose: "LOGIN"|"STEP_UP", channel?: "SMS"|"WHATSAPP"|"VOICE", integrityToken?: string }`
- Res 202: `{ challengeId, channel, resendAfterSec, expiresInSec }`. **Identical for registered and unregistered numbers.**
- Errors: 400, 429, 503 `PROVIDER_UNAVAILABLE` (suggests alternate channel)

**POST `/v1/auth/otp/verify`**: verify OTP, create session
- Actor: anonymous · Rate: `AUTH_OTP_VERIFY` · Idem: required (prevents double session on retry) · Audit: `auth.login_succeeded`/`auth.login_failed`
- Req: `{ challengeId, code: /^\d{6}$/, surface: "CUSTOMER_WEB"|"TECHNICIAN_APP"|"AGENT_WEB", device: { platform, appVersion, integrityToken? } }`
- Res 200 (app): `{ accessToken (JWT, 10 min), refreshToken (opaque), session: { id, absoluteExpiresAt }, user: { roles: ("CUSTOMER"|"TECHNICIAN"|"FIELD_AGENT")[], isNew } , nextStep?: "SECOND_FACTOR" }`. (web-bff: sets `__Host-session` cookie; returns `{ user }` only.)
- Validation: challenge unexpired, unconsumed, attempts < max. Constant-time compare. Agent surface requires a second factor (`nextStep`).
- Errors: 400 `OTP_INVALID` (generic, same for expired/consumed/wrong), 429

**POST `/v1/auth/second-factor/verify`** (field agents): TOTP/passkey → completes the session. Rate `AUTH_OTP_VERIFY`. Audit `auth.mfa_verified`.

**POST `/v1/auth/token/refresh`**: rotate refresh token (app)
- Actor: token holder · Rate: 30/h per session · Idem: implicit (token single-use) · Audit: `auth.refresh_reuse_detected` on reuse
- Req: `{ refreshToken }` → Res 200: `{ accessToken, refreshToken }`
- Reuse of a used token → **revoke the entire family** + all sessions of that device → 401 `SESSION_REVOKED` + security event.

**POST `/v1/auth/logout`**: revoke current session. Idem: not required. Audit `auth.logout`.
**GET `/v1/auth/sessions`** / **DELETE `/v1/auth/sessions/{sessionId}`**: list and revoke own sessions (AuthZ: own only). Audit `auth.session_revoked`.
**POST `/v1/auth/step-up`**: exchange a fresh OTP challenge for a 10-min step-up on the current session. Required before: phone change, payout-method add, account deletion, data export.

---

## 4. Customer profile, consent & data rights

**GET `/v1/customer/profile`** → `{ displayName?, preferredLocale, phoneMasked, marketingOptIn, version }` · AuthZ: CUS self · Rate `READ`
**PATCH `/v1/customer/profile`** · Idem required · Rate `WRITE` · Audit `customer.profile_updated` (fields only)
- Req: `{ expectedVersion, displayName?: string(1..40, letters/space), preferredLocale?: enum(city locales) }`
**GET `/v1/me/consents`** → `[{ purpose, status, noticeVersion, grantedAt? }]`
**PUT `/v1/me/consents/{purpose}`** · Idem required · Audit `consent.granted|withdrawn`
- Req: `{ action: "GRANT"|"WITHDRAW", noticeId, noticeVersion }`. Validation: notice is current for the locale. `SERVICE_DELIVERY` withdrawal → 409 `REQUIRES_ACCOUNT_CLOSURE` (explains the consequence).
**POST `/v1/me/data-requests`** · Step-up required · Idem required · Audit `dsr.opened`
- Req: `{ type: "ACCESS"|"CORRECTION"|"ERASURE"|"GRIEVANCE"|"NOMINATION", details?: string(≤1000) }` → 202 `{ requestId, dueAt, blockers?: [...] }`
**GET `/v1/me/data-requests/{id}`** → status + download link (ACCESS; signed, 24 h, single use).

---

## 5. Addresses & geo

**GET `/v1/customer/addresses`** → `[{ id, label, localityName, line1Masked ("H.No 12, …"), landmark, isServiceable }]`. (Full text is returned to its owner. Masking applies in lists for shoulder-surfing safety on shared phones.)
**GET `/v1/customer/addresses/{id}`** → full owner view. AuthZ: owner.
**POST `/v1/customer/addresses`** · Idem required · Rate `WRITE` · Audit `customer.address_added`
- Req: `{ label?, line1: string(3..120), line2?: string(≤120), landmark: string(3..120), localityId, point?: {lat,lng} (consented, India bbox), accessNotes?: string(≤200) }`
- Validation: locality active and in a live city. Point within 5 km of the locality centroid (else 400 `POINT_LOCALITY_MISMATCH`). Text is normalised (NFC) and control characters stripped.
- Res 201 `{ id, isServiceable }`
**PATCH `/v1/customer/addresses/{id}`** (expectedVersion) · **DELETE** (soft) · Audit each.
**GET `/v1/geo/localities?cityId=&q=`** · AuthN optional · Rate `READ` (anon: per IP 30/min) → `[{ id, name, zoneName, isServiceable }]` (≤20, trigram + alias search)
**POST `/v1/geo/serviceability`** → `{ serviceable: bool, cityId?, localityId? }`. Req `{ point } | { localityId }`. Anonymous allowed, rate-limited.

---

## 6. Service discovery

**GET `/v1/catalog/categories?cityId=`** → `[{ id, code, label, iconUrl, serviceTypes: [{ id, code, label, iconUrl }] }]` · Anonymous · Cacheable (CDN 5 min). Returns only service types **enabled for that city** (catalog status + city `service_rules.enabled`; [03 §8.1](03-database.md#81-v1-catalog-tree-seed-example)). For the pilot: Plumbing, Electrical, Appliance & Home Equipment (Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler). No category or service type is hard-coded in clients.
**GET `/v1/catalog/service-types/{id}/symptoms?cityId=`** → `[{ code, label, iconUrl }]`
**GET `/v1/catalog/price-guide?serviceTypeId=&cityId=`** → `{ visitFee: Money, visitFeeAdjustable: bool, typicalRepairRanges: [{ symptomCode, min: Money, max: Money }], disclaimerKey }` (from the active rate card; never a promise)
**POST `/v1/customer/problem-suggestions`**: AI-assisted categorisation (advisory)
- Actor CUS (or anon with booking draft token) · Rate 10/h · Idem not required · Audit: none (ai.request log)
- Req: `{ cityId, text?: string(≤500), voiceNoteFileId?, locale }` → `{ suggestions: [{ serviceTypeId, symptomCode, confidence: 0..1 }], requiresConfirmation: true }`
- Returns `[]` below the confidence threshold. Feature-flagged. **Never** creates anything.

---

## 7. Booking & job status (customer)

**POST `/v1/customer/jobs`**: create a job (+ diagnosis visit)
- Actor: CUS (verified session) · AuthZ: address owned by caller · Rate `CRITICAL` · **Idem: required** · Audit `job.created`
- Req:
```json
{ "clientRequestId": "uuid", "serviceTypeId": "…", "symptomCodes": ["FRIDGE_NOT_COOLING"],
  "problemText": "string ≤ 500 (optional)", "voiceNoteFileId": "optional", "photoFileIds": ["≤3"],
  "addressId": "…", "timing": { "type": "ASAP" } | { "type": "SLOT", "window": TimeWindow },
  "acceptedVisitFee": Money, "confirmSeparate": false,
  "paymentPreference": "ONLINE|CASH|EITHER", "onsiteAdult": "SELF|ADULT_FAMILY|OTHER_ADULT",
  "onsiteContact": { "name": "...", "phone": "..." } /* optional */, "preferredLanguage": "te|en|other" /* optional, Q-C */ }
```
- Validation: service type active in the city. Symptoms belong to the type. Files owned by the caller and CLEAN. Slot is one of the offered slots (server re-checks capacity heuristics). `acceptedVisitFee` equals the current visit fee (else `409 PRICE_CHANGED` with the new fee; **the client cannot set prices**). Address serviceable.
- Res 201: `{ jobId, publicRef, status, visits: [VisitSummaryForCustomer], visitFee: Money }`
- Errors: 409 `POSSIBLE_DUPLICATE` `{ existingJobId }` · 409 `PRICE_CHANGED` · 422 `NOT_SERVICEABLE` · 400 `SLOT_UNAVAILABLE`

**GET `/v1/customer/slots?serviceTypeId=&addressId=&date=`** → `[{ window, availability: "GOOD"|"LIMITED" }]` (coarse. Doesn't reveal technician counts.)
**GET `/v1/customer/jobs`** (cursor) → `[{ jobId, publicRef, serviceLabel, status, createdAt, nextAction? }]`
**GET `/v1/customer/jobs/{jobId}`** · AuthZ: owner → `{ jobId, publicRef, status, statusLabel, service, address: { label, localityName }, visits: [VisitSummaryForCustomer], quote?: QuoteSummary, bill?: BillSummary, warranty?: CoverageSummary, actions: ("CANCEL"|"APPROVE_QUOTE"|"PAY"|"RATE"|"CLAIM_WARRANTY"|"RESCHEDULE"|"SOS")[] }`
**GET `/v1/customer/jobs/{jobId}/timeline`** → customer-safe event list (no internal reasons, no technician metrics).
**GET `/v1/customer/jobs/{jobId}/cancellation-preview`** → `{ fee: Money, reasonKey, technicianCompensationIncluded: bool }`
**POST `/v1/customer/jobs/{jobId}/cancel`** · Idem required · Rate `CRITICAL` · Audit `job.cancelled`
- Req: `{ reasonCode: enum, acceptedFee: Money }`. `acceptedFee` must equal the preview (prevents surprise charges). Forbidden once a visit is ON_SITE (→ 409 `INVALID_STATE`, use support).
**PATCH `/v1/customer/visits/{visitId}/schedule`**: reschedule
- Idem required · Req `{ expectedVersion, window }` · Allowed in PLANNED/MATCHING/ASSIGNED. Audit `visit.rescheduled`.
**POST `/v1/customer/visits/{visitId}/contact-technician`**: create/return masked bridge
- AuthZ: owner; visit ASSIGNED..IN_PROGRESS · Rate 10/h per visit · Idem not required · Audit (disclosure_events `MASKED_CALL`)
- Res `{ dialNumber: "+91…(virtual)", validUntil }`. The number only connects when called **from the customer's registered phone**.
**POST `/v1/customer/visits/{visitId}/identity-check`**: "Is this the person at your door?"
- Req `{ matches: boolean }` · Audit `visit.identity_check`. `false` → P1 safety flow + ops call + technician asked to wait outside.

---

## 8. Technician availability

**GET `/v1/technician/availability`** → `{ online, todayCheckin?: { available, locality }, weekly: [...], overrides: [...] , serviceAreas: [{ locality, priority }] }`
**POST `/v1/technician/presence`** → Req `{ online: boolean }` · Rate `WRITE` · Idem required · Audit none (presence log in workforce)
**POST `/v1/technician/checkins`** → Req `{ serviceDate (today/tomorrow), available, localityId? }` · Validation: locality ∈ registered service areas · Idem required
**PUT `/v1/technician/weekly-availability`** → Req `{ expectedVersion, slots: [{ weekday, startMinute, endMinute }] }` (≤ 21 slots, non-overlapping) · Audit `tech.availability_changed`
**POST `/v1/technician/availability-overrides`** → Req `{ period, kind: "UNAVAILABLE"|"EXTRA_AVAILABLE", reasonCode? }`
**POST `/v1/technician/location-share`** (consented one-time) → Req `{ point, accuracyM, purpose: "SHARE_ONCE_FOR_MATCHING" }` · Requires consent `LOCATION_ONCE` · Stored ≤ 30 d.
Service areas and skills are changed **through agent/ops** (they affect matching eligibility) → admin endpoints.

---

## 9. Offers, accept/reject

**GET `/v1/technician/offers`** → `[OfferCard]`
```ts
OfferCard = { offerId, expiresAt, serviceLabel, purposeLabel: "Diagnosis visit"|"Repair visit"|"Warranty visit",
  symptomLabel, locality: LocalityRef, distanceBand?: "0-2 km"|"2-5 km"|"5-10 km"|">10 km",
  window: TimeWindow, urgency, requiredSkillLabel,
  earnings: { visitPayout: Money, typicalRepairRange?: { min: Money, max: Money }, breakdownKey },
  materialsNote?: string /* repair visits: material list from approved quote, no prices */ , jobRef: publicRef }
```
L0 data only (02 §5). No customer name, address or free text.

**POST `/v1/technician/offers/{offerId}/accept`**
- Actor TEC · AuthZ: offer addressed to the caller ∧ PENDING · Rate `CRITICAL` · **Idem required** · Audit `offer.accepted` + `assignment.created`
- Req `{ acknowledgedEarnings: Money }` (must equal the offer's visit payout. Protects against stale UI.)
- Res 200 `{ visitId, status: "ASSIGNED" }` · Errors: 409 `OFFER_NO_LONGER_AVAILABLE` (taken/expired/withdrawn: same code, no detail), 409 `CAPACITY_CONFLICT`, 403 `NOT_ELIGIBLE` (generic)
**POST `/v1/technician/offers/{offerId}/decline`** → Req `{ reasonCode?: "BUSY"|"TOO_FAR"|"NOT_MY_SKILL"|"PRICE"|"OTHER" }` · Idem required · no penalty in V1 metrics beyond acceptance-propensity ordering.

---

## 10. Technician visits, arrival, diagnosis, completion

**GET `/v1/technician/visits?status=active|upcoming|recent`** → `[VisitCardForTechnician]` (stage-gated)
**GET `/v1/technician/visits/{visitId}`**
- AuthZ: caller holds the ACTIVE assignment (or COMPLETED/NO_SHOW within window for L3 fields) · Rate `READ` · Audit: disclosure_event when L2 fields are returned
- Res (fields depend on disclosure level):
```ts
{ visitId, jobRef, purposes, status, window, service, symptomLabels,
  customer: { firstName?, language },                          // L1+
  locality: LocalityRef,                                       // L0+
  location?: { addressText, landmark, point?, accessNotes? },  // L2 only, with disclosureClosesAt
  problem?: { text?, photoUrls?, voiceNoteUrl? },              // L2 only (signed, 5 min)
  repair?: { approvedItems: [{ label, qty }], materials: [{ label, qty, unit }], quoteVersionNo }, // repair visits
  earnings: { expected: Money, breakdown: [...] },
  actions: ("DEPART"|"ARRIVE"|"START_WAIT"|"CALL_CUSTOMER"|"DIAGNOSE"|"CHECKOUT"|"COMPLETE"|"RECORD_CASH"|"RELEASE"|"SOS")[],
  disclosureLevel: "L1"|"L2"|"L3", disclosureClosesAt? }
```
**POST `/v1/technician/visits/{visitId}/release`** → Req `{ reasonCode, safetyConcern?: boolean }` · Idem required · Audit `assignment.released`
**POST `/v1/technician/visits/{visitId}/materials-confirmed`** (repair) → Req `{ items: [{ materialLineId, have: boolean }] }` · any `false` → RO BLOCKED flow + ops.
**POST `/v1/technician/visits/{visitId}/depart`** → Req `{ clientReportedAt }` · Idem required · Audit `visit.departed`
**POST `/v1/technician/visits/{visitId}/arrive`**
- Rate `CODE_ENTRY` · Idem required · Audit `visit.arrived` (presence proof)
- Req `{ startCode: /^\d{4}$/, clientReportedAt, location?: { point, accuracyM, mock: boolean } (consented) }`
- Errors: 400 `CODE_INCORRECT` `{ attemptsLeft }` · 423 `CODE_LOCKED` (ops notified)
**POST `/v1/technician/visits/{visitId}/wait/start`** → Req `{ callAttemptsMade: int, location? }` (server verifies ≥ 2 masked-call attempts in `call_sessions` or a location snapshot) · Audit `visit.wait_started`
**POST `/v1/technician/visits/{visitId}/contact-customer`** → masked bridge (same rules as the customer side; L2 window only).

**Diagnosis**
**POST `/v1/technician/visits/{visitId}/diagnoses`**: create draft · Idem required · AuthZ: active assignee, visit IN_PROGRESS, purpose includes DIAGNOSIS (or REPAIR for `ADDITIONAL_FINDING`)
- Req `{ kind: "INITIAL"|"ADDITIONAL_FINDING"|"WARRANTY_ASSESSMENT" }` → `{ diagnosisId, version }`
**PUT `/v1/technician/diagnoses/{diagnosisId}`**: replace draft content
- Idem required · Req:
```json
{ "expectedVersion": 3, "problemCode": "AC_WIRING_DAMAGE", "observedChips": ["NO_COOLING","BURNT_SMELL"],
  "observedNotes": "≤500", "severity": "MODERATE", "safetyAdviceCode": null,
  "items": [ { "type": "REPAIR_ITEM", "repairItemId": "…", "qty": 1 },
             { "type": "MATERIAL", "materialId": "…", "qty": 2, "proposedUnitPricePaise": 6000 },
             { "type": "CUSTOM_LABOUR", "qty": 1, "proposedUnitPricePaise": 10000, "reasonCode": "EXTRA_ACCESS_WORK" } ],
  "noRepairNeeded": false, "sameVisitFeasible": false, "materialAvailableNow": false,
  "mediaFileIds": ["…"], "warrantyAssessment": null }
```
- Validation: items exist and are active. Repair items match the service type. Qty bounds. Proposed material price within ±X% of reference or a reason code. Custom labour within rate-card band. Media owned and CLEAN, captured in-app. `SAFETY_HAZARD` requires `safetyAdviceCode`.
**POST `/v1/technician/diagnoses/{diagnosisId}/quote-preview`** → server-priced preview `{ lines, totals, technicianEarnings }` (no persistence)
**POST `/v1/technician/diagnoses/{diagnosisId}/submit`**
- Idem required · Rate `CRITICAL` · Audit `diagnosis.submitted` + `quote.version_presented`
- Req `{ expectedVersion, previewHash }`. The server re-prices. If the result ≠ preview → 409 `PRICE_RECALCULATED` (the client shows the new preview).
- Effect: diagnosis SUBMITTED. Quote version created + PRESENTED. Customer notified.
- Res `{ quoteVersionId, versionNo, totalPayable: Money, sameVisitOptionOffered: boolean }`
**POST `/v1/technician/visits/{visitId}/checkout`** (diagnosis-only end) → Idem required · Guard per 06 §3 · Audit `visit.completed`

**Completion (repair)**
**POST `/v1/technician/visits/{visitId}/complete`**
- Rate `CODE_ENTRY` · **Idem required** · Audit `visit.completed`, `repair_order.completed`
- Req `{ completionCode: /^\d{4}$/, materialUsage: [{ quoteItemId, qtyUsed, actualUnitCostPaise?, receiptFileId? }], afterPhotoFileIds?: [], outcome: "COMPLETE"|"PARTIAL", partialReasonCode? }`
- Validation: RO not CHANGE_PENDING. `qtyUsed ≤ qtyQuoted`. Receipt required where the material line ≥ threshold. After-photos if service rule requires.
- Errors: `CODE_INCORRECT`, `CODE_LOCKED`, 409 `CHANGE_PENDING`

---

## 11. Quotes & approval (customer)

**GET `/v1/customer/jobs/{jobId}/quote`** → current quote view
```ts
QuoteView = { quoteVersionId, versionNo, status, contentHash, presentedAt, expiresAt,
  diagnosis: { problemLabel, severity, safetyAdvice?, photos?: signedUrl[], explainedBy: TechnicianCard },
  lines: [{ type, label, qty, unitPrice: Money, amount: Money, referencePriceNote? }],
  totals: { itemsTotal, visitFeeCredit, discount, tax, totalPayable },
  warranty: { days, labelKey }, repairOptions: [{ option: "SAME_VISIT"|"SAME_TECHNICIAN"|"RECOMMENDED_SPECIALIST", available: bool, reasonKey? }],
  previousApproved?: { versionNo, totalPayable }  // shown on change orders: "was ₹400, now ₹650"
}
```
**POST `/v1/customer/quote-versions/{quoteVersionId}/approve`**
- Actor: CUS who owns the job (INV-08) · Rate `CRITICAL` · **Idem required** · Audit `quote.approved`
- Req `{ contentHash, repairPreference: "SAME_VISIT"|"SAME_TECHNICIAN"|"RECOMMENDED_SPECIALIST", allowFallback: boolean, preferredWindow?: TimeWindow }`
- Validation: version is PRESENTED and the latest. Hash matches. Option is available. Above `high_value_threshold` → step-up OTP required (`401 STEP_UP_REQUIRED`).
- Errors: 409 `QUOTE_CHANGED` (returns latest QuoteView), 409 `QUOTE_EXPIRED`, 409 `OPTION_UNAVAILABLE`
**POST `/v1/customer/quote-versions/{quoteVersionId}/reject`** → Req `{ contentHash, reasonCode: "TOO_EXPENSIVE"|"WILL_DO_LATER"|"SECOND_OPINION"|"NOT_NEEDED"|"OTHER" }` · Idem required · Audit `quote.rejected`

**Signed-link approval (customers without a session; e.g., ops-booked)**
> **Errata SR-05:** the link token travels only in the URL **fragment** (`/q#t=…`), never in a path or query, so it can't reach CDN/WAF/app logs or referrers. The page sends it in the request body. The endpoints below therefore become `POST /v1/links/quotes/view`, `POST /v1/links/quotes/otp`, `POST /v1/links/quotes/decision`, each with `{ token }` in the body. Link-preview bots get a generic page.

**GET `/v1/links/quotes/{token}`** *(superseded by the fragment model above)* → minimal QuoteView (no address, technician first name only) · Rate `LINK` · token single-purpose, expires with the version
**POST `/v1/links/quotes/{token}/otp`** → sends OTP to the **job's customer number** (never a number supplied in the request) · Rate `AUTH_OTP_SEND`
**POST `/v1/links/quotes/{token}/decision`** → Req `{ challengeId, code, decision, contentHash, repairPreference?, allowFallback?, preferredWindow?, reasonCode? }` · Idem required · Audit `quote.approved|rejected` (channel `SIGNED_LINK_OTP`)

---

## 12. Repair scheduling

**GET `/v1/customer/repair-orders/{repairOrderId}`** → `{ status, performerPreference, preferredTechnician?: TechnicianCard, allowFallback, materials: [{ label, qty }], visits: [VisitSummaryForCustomer], nextAction }`
**GET `/v1/customer/repair-orders/{repairOrderId}/slots`** → slots (as §7)
**POST `/v1/customer/repair-orders/{repairOrderId}/schedule`**
- Idem required · Rate `CRITICAL` · Audit `repair_order.scheduled`
- Req `{ window, performerPreference?, allowFallback? }` (changing preference after approval is allowed until a repair visit is ASSIGNED)
- Effect: creates/updates the repair visit (PLANNED). Matching starts per lead time.
**POST `/v1/customer/repair-orders/{repairOrderId}/cancel`** → preview + `acceptedFee` (as job cancel) · Audit.

---

## 13. Payment & cash

**GET `/v1/customer/jobs/{jobId}/bill`** → `{ billId, status, lines: [...], amountDue: Money, amountPaid: Money, methodsAvailable: ("UPI"|"CARD"|"NETBANKING"|"CASH")[], invoiceUrl? }`
**POST `/v1/customer/bills/{billId}/payment-intents`**
- Actor CUS owner · Rate `CRITICAL` · **Idem required** (72 h) · Audit `payment.intent_created`
- Req `{ amount: Money (must equal amountDue), methodHint?: "UPI_INTENT"|"UPI_COLLECT"|"CARD"|"NETBANKING" }`
- Res 201 `{ paymentIntentId, provider, checkout: { orderId, keyId (publishable), upiIntentUrl?, expiresAt } }` (no secrets; provider public key only)
- Errors: 409 `BILL_CHANGED`, 409 `ALREADY_PAID`, 503 `PROVIDER_UNAVAILABLE` → offer pay-later link/cash
**GET `/v1/customer/payment-intents/{id}`** → `{ status: "PENDING"|"SUCCEEDED"|"FAILED"|"EXPIRED", failureReasonKey? }`. Polled after redirect. **The server verifies with the PA before returning SUCCEEDED** if no webhook has arrived yet.
**POST `/v1/technician/visits/{visitId}/cash`**: record cash collected
- AuthZ: assignee; bill OPEN for the job · Idem required · Audit `cash.recorded`
- Req `{ billId, amount: Money }` · Validation: amount == amountDue (INV-24); otherwise 422 `CASH_AMOUNT_MISMATCH` → the app routes to "Call support"
- Effect: cash collection PENDING. Customer confirmation request sent (push/WhatsApp/IVR).
**POST `/v1/customer/cash-collections/{id}/confirm`** → Req `{ confirmed: boolean }` · Idem required · Audit `cash.confirmed|denied`
**GET `/v1/customer/jobs/{jobId}/invoice`** → `{ invoiceNumber, issuedAt, downloadUrl (signed 5 min) }`

---

## 14. Refunds (admin) & customer refund requests

Customers don't call a refund endpoint directly. They raise a complaint (category PRICE/QUALITY/PAYMENT), and refunds are decided by ops/finance.

**POST `/admin/v1/refunds`**
- Actor: Support L2 (≤ threshold) / Finance · AuthZ: `payments.refund.request` + city scope · Rate `ADMIN` · **Idem required** · Audit `refund.requested`
- Req `{ paymentId, amount: Money, reasonCode, linkedComplaintId?, linkedDisputeId?, note: string(≤500) }`
- Validation: amount ≤ refundable (INV-12). Payment CAPTURED. Above threshold → creates an `approval_request` (status `PENDING_APPROVAL`).
- Res 201 `{ refundId, status, approvalRequestId? }`
**POST `/admin/v1/approvals/{approvalRequestId}/decision`** → Req `{ decision: "APPROVE"|"REJECT", comment }` · AuthZ: `required_approver_permission` ∧ approver ≠ requester (INV-19) · Step-up (passkey) · Audit `approval.decided`
**GET `/admin/v1/refunds/{id}`** → status, provider ref (masked), timeline.

---

## 15. Warranty

**GET `/v1/customer/warranties`** → `[{ coverageId, jobRef, serviceLabel, coveredItems: [label], endsAt, status, canClaim }]`
**POST `/v1/customer/warranty-claims`**
- Idem required · Rate `WRITE` · Audit `warranty.claim_submitted`
- Req `{ coverageId, symptomCodes: [], description?: string(≤500), mediaFileIds?: [] }`
- Validation: coverage owned, ACTIVE, no open claim.
- Res 201 `{ claimId, status, eligibility: "AUTO_ELIGIBLE"|"NEEDS_REVIEW"|"INELIGIBLE", reasonKey?, warrantyJobId? }`
**GET `/v1/customer/warranty-claims/{claimId}`** → status, decision reason, linked job.
**POST `/v1/customer/warranty-claims/{claimId}/contest`** → opens dispute · Req `{ statement: string(≤1000), mediaFileIds? }`

---

## 16. Complaints, disputes, support

**POST `/v1/complaints`**
- Actor CUS/TEC · AuthZ: party to the referenced job/visit (if given) · Idem required · Rate 10/day · Audit `complaint.raised`
- Req `{ jobId?, visitId?, category, description: string(≤1000), mediaFileIds?: [], voiceNoteFileId? }`
- Res 201 `{ complaintId, reference, slaHours, nextStepKey }`. `SAFETY` category → routed as a safety incident too.
**GET `/v1/complaints/{id}`** → own complaint status (no investigator notes, no other party's statements).
**POST `/v1/complaints/{id}/statements`** → Req `{ text, mediaFileIds? }` (a party adds their side; both parties get this).
**POST `/v1/disputes/{id}/appeal`** → Req `{ statement }` · within appeal window · Audit `dispute.appealed`
**GET `/v1/support/contacts?cityId=`** → `{ phone, whatsapp, hours, languages, sosNumber }` (from brand config)
**POST `/v1/support/callback-requests`** → Req `{ topic, jobId?, preferredLanguage }` · Idem required · Rate 5/day

---

## 17. Ratings

**POST `/v1/customer/jobs/{jobId}/ratings`**
- AuthZ: owner; the ratee had a COMPLETED visit on this job · Idem required · Audit `rating.submitted`
- Req `{ technicianRef, stars: 1..5, tags?: enum[] (≤5), comment?: string(≤500) }` · Unique per (job, technician) (INV-16). Editable 48 h via PUT.
**POST `/v1/technician/visits/{visitId}/customer-rating`** → Req `{ stars, tags?: ("RESPECTFUL"|"UNSAFE"|"PAYMENT_ISSUE"|"DELAYED_ACCESS")[] }` (private; `UNSAFE` → safety review).
Technicians see their own aggregates via earnings/profile. Individual customer ratings are shown **only after both sides submit or the 48 h window closes** (blind).

---

## 18. SOS

**POST `/v1/sos`**
- Actor CUS/TEC with a session. Logged-out or offline users still get `tel:` links (112, safety desk) on the SOS screen, which work without the backend · Rate `SOS` (never blocked; deduped 60 s) · Idem required · Audit `safety.sos_raised`
- Req `{ visitId?, kind: "IMMEDIATE_DANGER"|"HARASSMENT"|"MEDICAL"|"OTHER", location?: { point, accuracyM } (consent prompt shown inline), note?: string(≤300) }`
- Res 201 `{ incidentId, safetyDeskPhone, deskStatus: "STAFFED"|"OUTSIDE_HOURS", messageKey, emergencyNumber: "112" }`. **No numeric response-time promise** until staffing is confirmed (X-33). Outside desk hours the message directs the user to 112 and the fallback line
- Effect: P1 incident, pager to the safety desk, auto callback, job `safety_hold` if appropriate.
**GET `/v1/sos/{incidentId}`** → `{ status, acknowledgedAt? }` (raiser only)

---

## 19. Technician earnings & payout methods

**GET `/v1/technician/earnings/summary`** → `{ today: Money, thisWeek: Money, pendingPayout: Money, nextPayoutDate, cashCommissionDue: Money, holdReasonKey? }`
**GET `/v1/technician/earnings/statement?from=&to=`** → `[{ date, jobRef, visitPurpose, gross, commission, fees, net, type: "VISIT"|"REPAIR"|"CANCELLATION_COMP"|"WAITING"|"ADJUSTMENT"|"PAYOUT" }]` (from the ledger. Every deduction is explicit.)
**GET `/v1/technician/payouts`** → `[{ payoutId, period, net, status, paidAt?, destinationMasked }]`
**GET `/v1/technician/payout-methods`** → `[{ id, type, display: "SBI ••••1234"|"ram••@upi", status, coolingOffUntil? }]`
**POST `/v1/technician/payout-methods`**
- **Step-up required** · Rate `CRITICAL` (2/day) · Idem required · Audit `payout_method.added` (security event, INV-26)
- Req `{ type: "BANK_ACCOUNT", accountNumber: /^\d{9,18}$/, ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/ } | { type: "UPI_VPA", vpa: /^[\w.-]{2,256}@[a-zA-Z]{2,64}$/ }`
- Effect: penny-drop + name match (async) → PENDING_COOLING_OFF (72 h default) → notifications on the old method's SMS, the app and IVR. Payouts during cooling-off go to the **previous** active method (or are held if none).
- Res 202 `{ payoutMethodId, status, coolingOffUntil }`

---

## 20. Notifications, devices, uploads

**POST `/v1/devices`** → register/update `{ platform, appVersion, pushToken?, integrityToken? }` · Idem required
**GET `/v1/notifications`** (cursor) → in-app inbox `[{ id, titleKey, bodyKey, params, createdAt, read, deepLink }]` (params never contain addresses)
**POST `/v1/notifications/{id}/read`**
**GET/PUT `/v1/me/notification-preferences`** → `{ whatsapp: bool, sms: bool (transactional SMS can't be disabled), promotional: bool (consent-linked), quietHours?: { start, end } }`
**POST `/v1/uploads`**: presigned upload slot
- Rate `UPLOAD` · Idem required · Req `{ kind: "PROBLEM_PHOTO"|"PROBLEM_VOICE"|"DIAGNOSIS_PHOTO"|"AFTER_PHOTO"|"RECEIPT"|"KYC_DOC"|"COMPLAINT_MEDIA", contentType, sizeBytes, contextRef: { type, id } }`
- Validation: kind allowed for the actor and context (e.g., DIAGNOSIS_PHOTO only for an active assignee). Type/size per [10](10-files-and-data.md).
- Res 201 `{ fileId, uploadUrl (PUT, 5 min), requiredHeaders }`
**POST `/v1/uploads/{fileId}/complete`** → 202 `{ status: "SCANNING" }`. **GET `/v1/uploads/{fileId}`** → `{ status: "SCANNING"|"CLEAN"|"REJECTED" }`

---

## 21. Field-agent surface (V1 minimal)

All agent actions record `actor=FIELD_AGENT, on_behalf_of=technician`. They require an active agent-technician link (or onboarding draft ownership) and MFA.
- `POST /v1/agent/technician-drafts` (create onboarding draft: name, phone, languages, localities, skills claimed). **The technician's own consent** is captured separately (IVR/OTP to the technician's phone) before submission.
- `POST /v1/agent/technician-drafts/{id}/documents` (upload slots, kind `KYC_DOC`)
- `POST /v1/agent/technician-drafts/{id}/submit` → to the verification queue (agents **cannot** approve)
- `GET /v1/agent/technicians` (linked only) → status, next actions, no customer data
- `POST /v1/agent/technicians/{id}/ivr-pin-reset-request` → triggers an IVR call to the technician's registered phone to set a new PIN (the agent never sees or sets the PIN)
- `POST /v1/agent/technicians/{id}/availability` (on behalf, logged)

---

## 22. Admin API (selected V1 endpoints)

| Endpoint | Permission | Maker-checker | Audit |
|---|---|---|---|
| `GET /admin/v1/jobs?city=&status=&q=` | `jobs.read` | — | access log |
| `GET /admin/v1/jobs/{id}` (full timeline, PII masked) | `jobs.read` | — | — |
| `POST /admin/v1/pii-reveals` `{ subjectType, subjectId, field, reasonCode, ticketRef }` | `pii.reveal.<field>` | no (rate-limited, alerting) | `pii.revealed` |
| `POST /admin/v1/visits/{id}/manual-assign` `{ technicianId, reasonCode, expectedVersion }` | `dispatch.assign` | no | `assignment.manual` |
| `POST /admin/v1/visits/{id}/presence-override` `{ kind, callSessionId, reasonCode }` | `dispatch.override_presence` | **yes** | `visit.presence_override` |
| `POST /admin/v1/jobs/{id}/booking` (book on behalf) | `support.book` | no | `job.created(channel=OPS)` |
| `POST /admin/v1/quote-versions/{id}/recorded-approval` | `support.record_approval` | **yes** (second ops) | `quote.approved(channel=OPS_RECORDED_CALL)` |
| `POST /admin/v1/diagnoses` (capture for a basic-phone technician on a bridged call) | `support.capture_diagnosis` | no | `diagnosis.captured_by_ops` |
| `POST /admin/v1/refunds` | `payments.refund.request` | above threshold | `refund.*` |
| `POST /admin/v1/payout-batches` / `{id}/approve` | `finance.payout.prepare` / `.approve` | **yes** | `payout_batch.*` |
| `POST /admin/v1/rate-cards` / `{id}/submit` / approve | `pricing.edit` / `pricing.approve` | **yes** | `pricing.*` |
| `POST /admin/v1/verification-cases/{id}/decision` | `verification.decide` | no (2nd review for FAIL→PASS overrides) | `verification.decided` |
| `POST /admin/v1/sanctions` / approve | `trust.sanction.propose` / `.approve` | suspension/deactivation: **yes** | `sanction.*` |
| `POST /admin/v1/safety-incidents/{id}/ack` / `/hold` | `safety.*` | no | `safety.*` |
| `POST /admin/v1/grants` | `security.grant` | **yes** | `admin.grant_changed` |
| `POST /admin/v1/technicians/{id}/payout-methods/disable` | `finance.payout_method.disable` | no (disabling is safe) | security event |
| `GET /admin/v1/audit-logs` | `audit.read` | — | meta-audited |

Admin endpoints never return decrypted Confidential/Restricted fields except through `pii-reveals` (short-lived, single field, logged).

---

## 23. Webhooks & internal voice endpoints

| Endpoint | Caller | Verification | Behaviour |
|---|---|---|---|
| `POST /hooks/payments/{provider}` | PA | HMAC signature over raw body + timestamp tolerance 5 min | Insert `provider_events` (unique provider event id) → 200 in < 200 ms → async processing. Unknown event types: stored and ignored. |
| `POST /hooks/telephony/{provider}/status` | Telephony | Provider signature/token + IP allowlist | Insert raw call event → async update `call_sessions` |
| `POST /hooks/telephony/{provider}/flow` | Telephony (IVR step) | Signature + IP allowlist + per-call nonce | Forwarded synchronously to the `voice` role (mTLS). Must answer < 800 ms p95 |
| `POST /hooks/whatsapp` | BSP | Signature (`X-Hub-Signature-256` or BSP equivalent) | Delivery receipts, opt-out keywords, **inbound messages are not processed as commands in V1** (auto-reply with support number) |
| `POST /hooks/sms/{provider}/dlr` | SMS | Token + IP allowlist | Delivery receipts |
| `POST /hooks/verification/{vendor}` | KYC/BGV | Signature | Case result fetched via API (webhook = trigger only) |

Webhook payloads are untrusted. Amounts/status are **re-fetched from the provider API** before any money state change ([09 §6](09-payments-ledger.md#6-provider-integration-rules)).
