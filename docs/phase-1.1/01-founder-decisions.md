# Phase 1.1 · 01 — Founder Decisions, Pilot Assumptions & Primary Workflow

> Status: **DRAFT for founder review** · Date: 2026-10-08
> This document records the founder's direction on D-01…D-18 and what each decision means for the Phase 1 design. Where the direction changes a Phase 1 recommendation, the change is stated explicitly. ⚖️ = needs Indian legal/CA advice.

---

## 1. Primary workflow (explicit confirmation)

The **primary, architecturally default workflow** is:

```
Customer problem → Diagnosis visit → Diagnosis result → Quote → Customer approval
→ Repair order → Repair visit → Completion → Payment → Warranty
```

- **Same-visit repair is an optimisation, not the default.** It happens only when *all* guards pass: service rules permit it, the diagnosing technician holds a `can_repair` skill for the required type, the material is available now, the customer explicitly chooses "Same technician now", and the approval arrives within the configured on-site wait. (Phase 1 [06 §3](../phase-1/06-job-workflows.md) guard. Unchanged.)
- The Phase 1 model already supports everything the founder listed. Here is where each lives:

| Requirement | Phase 1 mechanism |
|---|---|
| Same technician | `RepairOrder.performer_preference = SAME_TECHNICIAN` → direct offer |
| Different technician | `RECOMMENDED_SPECIALIST` → cascade on `required_skill` |
| Different skill | `diagnoses.required_repair_service_type_id/specialization_id` → `visits.required_*`. Skills carry `can_diagnose` / `can_repair` |
| Separate repair visit | `visits` (purpose REPAIR) linked by `repair_order_id`, with its own codes, window and assignment |
| Material requirements | `repair_orders.materials_required` snapshot + `materials_confirmed_at` + IVR/app material check before departure |
| Rescheduling | `PATCH /customer/visits/{id}/schedule`, RO → AWAITING_SCHEDULE on visit cancellation, technician re-confirmation |
| Warranty revisit | New job with `warranty_parent_job_id`, visit purpose `WARRANTY_INSPECTION`, conflict-of-interest filter H16 |

One wording fix is still needed (contradictions X-01/X-02 in [02-contradictions](02-contradictions.md)): Phase 1 [02 §3](../phase-1/02-domain-model.md) mislabels a job state (`WORK_COMPLETED`) and a visit state (`SCHEDULED`).

---

## 2. Decision register

| ID | Founder direction | Status | Effect on Phase 1 design |
|---|---|---|---|
| D-01 | Stage-gated disclosure approved. Address only when operationally necessary. Never by SMS | **APPROVED** | ADR-009 stands. Add: L2 also requires `customer_verified = true` or an ops-confirmed call (X-04). Window offsets stay configurable |
| D-02 | IVR PIN | **APPROVED** | As designed. See security review SR-12 (provider-side DTMF logging) |
| D-03 | Double confirmation for important actions, especially acceptance and state changes | **APPROVED** | Change: **confirmation is no longer relaxable after 20 jobs** (Phase 1 08 F1 note removed). Code-entry actions get a *visit read-back* before the code ("{locality} visit, 4–6 PM: 1 to continue") so the confirm step happens before code entry, not after. App: deliberate **slide-to-accept** instead of a single tap. See §4 |
| D-04 | Customer choice: same technician now / same technician later / recommended specialist | **APPROVED** | Labels renamed: `SAME_VISIT` → "Same technician now". **Clarification needed:** we read "may choose a specialist when the first technician does not have the required skill" as *permissive* (specialist is always offered, and is the only option when the first technician lacks the skill). Please confirm (§5 Q-A) |
| D-05 | One final bill where appropriate. Separate visit-fee bill for diagnosis-only, rejected, expired or cancelled repair | **APPROVED** | Matches Phase 1 06 §2. Add: if a visit-fee bill was paid and the customer later approves a re-quote, the final bill shows a **"visit fee already paid"** credit line (X-22) |
| D-06 | PARTIAL diagnosis payout as the provisional default for same-technician diagnosis + repair | **APPROVED (provisional)** | `diagnosis_payout_when_same_tech_repairs = PARTIAL` (50% in the simulator, configurable) |
| D-07 | Don't finalise ₹149. Build a simulator. Recommend 3 models | **PENDING** (needs pilot data) | [06-pricing-and-unit-economics](06-pricing-and-unit-economics.md). No pricing rule is final |
| D-08 | Payment-flow model | **PENDING ⚖️** | No live money-flow code depending on Model A/B. The manual pilot uses a direct-pay interim (see [09-manual-pilot §6](09-manual-pilot.md)) |
| D-09 | Keep data model + consent. Display OFF. No gender in ranking | **APPROVED** | Feature flag `segment_rating_display = false`. INV-20 stands |
| D-10 | No final brand. Housefi/GharSaathi are internal working names | **APPROVED (non-decision)** | ADR-016 stands. Neutral `applicationId` and DLT header still need a *neutral* choice before any Play/DLT registration (§5 Q-B) |
| D-11 | Ops-recorded approval only as an accessibility fallback, with strict controls and a threat analysis first | **PENDING**. The Phase 1 recommendation (normal channel ≤ ₹2,000) is **REJECTED** | Threat analysis in §3. Recommendation: keep the channel **built but disabled**. Enable only after D-15 legal review and the controls in §3 |
| D-12 | ₹2,000 customer IVR approval limit, provisional | **PENDING** (prototype + legal) | Config value, marked provisional. Validated in the IVR field test with customers ([07](07-ivr-field-test.md) §9) |
| D-13 | Cash at launch with a configurable negative-balance cap. Restrict new cash jobs, keep online jobs, show reason and amount, never hide earnings | **APPROVED** | Design gap found (X-24): payment method isn't known at offer time. Resolution in §6 |
| D-14 | Cancellation/no-show compensation requires system evidence. Anti-abuse controls | **APPROVED in principle** | Evidence ladder + controls in §7 |
| D-15 | Call recording pending legal. No unrestricted recording | **PENDING ⚖️** | All recording features flag-off. Diagnosis desk uses structured notes. D-11 depends on D-15 |
| D-16 | IVR quiet hours 9 PM–7 AM unless opted in | **APPROVED** | As designed (07 H7, 08) |
| D-17 | Test environment | **APPROVED** | As designed (14 §1) |
| D-18 | Field-agent assist mode with scope, time limit, on-behalf logging, no escalation, no verification/assignment, auto-expiry | **APPROVED** | Specification in §8. Security review SR-03 requires **phishing-resistant MFA for agents using assist mode** |

---

## 3. D-11 threat analysis: ops-recorded customer approval

**What the capability is:** an ops agent calls the customer's registered number, reads out the quote, and records the customer's verbal approval. A second ops member verifies the recording. This exists for customers who can't use a link + OTP *or* the keypad IVR (e.g., visually impaired, very elderly, hands occupied, no feature-phone familiarity).

| # | Threat | Actor | Exploit path | Impact | Control | Residual |
|---|---|---|---|---|---|---|
| T1 | Fabricated approval | Rogue ops agent (+ colluding verifier) | Agent marks "approved" with a call to a different number or a silent call | Customer charged for unapproved work | Call must be **outbound from the platform** to the **registered number** (`call_sessions` proves direction and destination hash). The recording is mandatory evidence. Verifier ≠ recorder ≠ diagnosis capturer. Verifier pairs rotated. Pair-frequency analytics | Low–Medium (2-person collusion) |
| T2 | Technician impersonates the customer | Technician | Technician answers the ops call on the customer's phone, or asks ops to call "my customer on this number" | Inflated quote approved by the technician | Never call a number supplied by the technician. **Identity check:** the customer reads back a **one-time code sent by SMS to their registered number at call start** (proves possession of the phone, not just knowledge of booking facts the technician also knows). The call must happen while the technician is **not** ON_SITE, or the customer confirms they are speaking privately | Medium (technician physically present with the customer's phone) |
| T3 | Coercion on site | Technician | Technician pressures the customer during the call | Unwanted work | Script asks "Is the technician near you? Are you comfortable approving?" Customer can request a callback later. Approval followed by an **SMS/IVR confirmation receipt** and a **15-minute cooling window** before work starts above a lower limit | Medium |
| T4 | Wrong person on a shared phone | Family member | Someone else approves | Disputes | Identity question + code read-back. Approval receipt to the registered number. Dispute path | Low–Medium |
| T5 | Recording tampering or loss | Insider/vendor | Edit or delete the recording | No evidence | Recording hash stored in the approval row. Object Lock on approval recordings. Provider copy deleted only after the hash matches | Low |
| T6 | Overuse as a convenience channel | Ops culture | Agents default to recorded approvals because they're faster | Erodes the "customer's own channel" principle | Allowed only when the customer flags `accessibility_assist` (self-declared with consent, or after link + IVR attempts failed). Per-agent and per-technician usage dashboards. Monthly review | Medium |
| T7 | Legal invalidity of recorded consent ⚖️ | — | — | Approvals unenforceable / privacy violation | D-15 legal review must confirm recording basis, notice text, retention | Unknown until legal review |

**Recommendation:** keep the capability **designed and implemented behind a disabled flag**, and do not use it in the pilot until:
1. D-15 legal review approves recording for this purpose.
2. **Value limit ≤ ₹1,000** (provisional, lower than the Phase 1 ₹2,000).
3. Customer `accessibility_assist` flag or two failed attempts on own-channel methods.
4. SMS code read-back identity verification.
5. Verifier ≠ recorder ≠ diagnosis capturer, verifier listens to the recording **before** the repair proceeds (SLA 10 min).
6. Approval receipt to the customer, plus a dispute path.
7. Complete evidence record (`quote_approvals` + `call_sessions` + recording hash). **No evidence, no approval** (DB CHECK already requires `call_session_id`, recorder and verifier).

---

## 4. D-03 confirmation matrix

| Action | IVR | Android app |
|---|---|---|
| Accept offer | Menu `1` → "Pakka karne ke liye phir 1" (two presses) | Slide-to-accept + earnings shown on the same screen |
| Decline offer | Single press (non-harmful; reversible until expiry via hotline "Naye kaam") | Single tap + optional reason |
| Depart | Visit read-back → `1` → confirm `1` | Tap + confirm dialog |
| Arrive | Visit read-back → `1` → **start code** (code = confirmation) | Code entry screen (code = confirmation) |
| Diagnosis submit (app) | n/a (ops desk) | Preview screen showing the customer price → "Send to customer" |
| Complete | Visit read-back → `1` → **completion code** → materials question → payment question | Code entry + material usage review |
| Record cash | "₹{amount} nakad liya? 1" → confirm `1` | Confirm dialog showing the amount |
| Availability check-in | Confirm summary `1` | Single toggle (low risk, reversible) |
| Release assignment | Reason → confirm `1` | Reason + confirm dialog |
| SOS | **No confirmation** (speed > accuracy). False SOS handled humanely | Long-press or tap + one confirm (avoid pocket triggers) |

---

## 5. Clarifications requested from the founder

- **Q-A (D-04):** Is "Recommended specialist" always offered (our reading), or only when the diagnosing technician lacks the repair skill?
- **Q-B (D-10):** Approve a brand-neutral technical identifier now (e.g., a neutral Android package name and a legal-entity-based DLT header), since these can't be changed later even though the brand stays open?
- **Q-C (pilot):** Kurnool has notable Urdu- and Kannada-speaking populations (border district). We **won't add** these languages. Should the pilot customer interviews record language preference, so the data informs a later decision?

---

## 6. D-13 cash design (resolving X-24)

**Problem:** the cap restricts "new cash jobs", but the payment method is chosen at the end of a job.

**Resolution:**
1. **Booking adds `payment_preference`** = `ONLINE` / `CASH` / `EITHER` (default `EITHER`; the customer can change it later). It's a soft signal, not a commitment.
2. Technician `cash_status` = `OK` / `CAPPED` (net position < −cap).
3. **Matching:** a `CAPPED` technician is ineligible (hard filter **H18**) only for visits whose customer chose `CASH`. `EITHER`/`ONLINE` visits stay eligible, so the technician keeps earning.
4. **At completion:** if the technician is `CAPPED`, the cash option is disabled for this job. The customer is shown UPI QR/link on *their* phone (PWA/SMS link). If the customer truly can't pay online, ops is called, and the collection is recorded as `CASH_EXCEPTION` with ops approval (no silent block of the technician's earnings).
5. **Technician visibility** (app earnings screen / IVR option 5 / SMS): "Cash commission due: ₹1,620. Cash jobs paused until ≤ ₹1,500. Pay ₹120+ via UPI link or it will be adjusted from your next payout on {date}." **Gross earnings, deductions and net are always shown. Nothing is hidden.**
6. Settlement: UPI collect link to the platform, or automatic netting at the next payout (already in [09 §4.4](../phase-1/09-payments-ledger.md)).
7. The cap is config per city. A breach triggers no penalty or metrics impact.

Spec changes: add `jobs.payment_preference`, matching filter H18, a `cash_status` projection in workforce, and the `CASH_EXCEPTION` flow. No code exists yet.

---

## 7. D-14 compensation evidence & anti-abuse

**Evidence ladder** (compensation is paid only at the level the evidence supports):

| Level | Evidence | Eligible compensation |
|---|---|---|
| E0 | Assignment only (accepted, not departed) | **None** (fee share only if the customer paid a late-cancel fee, per policy) |
| E1 | Departure recorded (app tap or IVR from the registered number with PIN) **and** elapsed time since departure ≥ `min_travel_minutes(locality distance)` | Partial travel compensation (e.g., 50%) |
| E2 | E1 + one of: consented location snapshot near the locality, ≥ 2 masked-call attempts to the customer logged, or a customer acknowledgement ("technician is on the way" call) | Full travel compensation |
| E3 (no-show claim) | E2 + wait record ≥ grace with call attempts during the wait | Full no-show compensation + customer no-show fee |

**Anti-abuse controls:**
1. **Plausibility:** departure-to-cancel time vs. locality travel estimate. Departures marked suspiciously early (e.g., departed 3 h before a slot 2 km away) get compensation capped at E1.
2. **Accrual, not instant payment:** compensation accrues as `PENDING_REVIEW` for 72 h (the dispute window), then joins the weekly payout. The customer can contest ("technician never came") → dispute.
3. **Caps:** per technician per week (e.g., max 3 compensated cancellations, or ₹X), per customer–technician pair (max 1 per 30 days without review).
4. **Collusion detection:** the same customer repeatedly cancels after travel with the same technician → fraud signal. New customers (first booking) cancelling after travel → compensation funded but flagged.
5. **Outlier review:** technicians in the top 5% compensation rate in their zone → ops review (not automatic penalty).
6. **Customer side:** the cancellation fee is shown before confirming cancel (Phase 1 API `acceptedFee`). Fee waivers for genuine emergencies via support.
7. **Technician no-show:** compensation to the customer = a goodwill discount (no wallet). The technician gets **no penalty without review**, and reasons (phone died, accident) are accepted through the hotline/agent.

---

## 8. D-18 assist mode specification

| Property | Rule |
|---|---|
| Who grants | Ops (dispatch/support L2) for a **specific visit** and a **specific agent** linked to the assigned technician |
| Scope | L2 view of that visit only (address, landmark, access notes). Can trigger a masked bridge to the customer **only if the technician is on the call** (3-way) or the technician requested it via IVR. Can submit IVR-equivalent actions *on behalf of* the technician (depart, availability) |
| Explicitly **not** allowed | Accept offers. Enter start/completion codes (the technician must enter them, or the customer confirms to ops). Approve quotes. Verify documents. Assign jobs. Change payout methods. See other visits/customers. Export anything |
| Duration | ≤ 2 h, auto-expiring. Cannot be renewed by the agent. Renewal is a new ops grant with a reason |
| Authentication | Agent session with **phishing-resistant MFA (passkey)** for assist mode. TOTP-only agents can't receive assist mode (SR-03) |
| Logging | Every view/action is logged with `actor = agent`, `on_behalf_of = technician`, `grant_id`, plus disclosure events. The technician gets an SMS: "Agent {name} is helping you with visit {code} until {time}" |
| Abuse signals | Assist grants per agent, per technician. Address views per grant. Grants without subsequent technician activity |

---

## 9. Pilot assumptions (recommended, all configurable)

| Item | Assumption | Configuration point |
|---|---|---|
| City | **Kurnool, Andhra Pradesh** | `geo.cities` (status PILOT) |
| Languages | **Telugu (te-IN) + English (en-IN)**. Hindi **not** added | `cities.supported_locales`, IVR prompt catalog per locale |
| Geography | **2–4 tightly controlled, contiguous zones** chosen after supply mapping (dense residential areas with a reachable technician pool). Not the whole city | `geo.zones` status ACTIVE/INACTIVE |
| Categories | **Plumbing, Electrical, Appliance & Home Equipment** (revised 2026-10-08, ADR-020). Appliance service types for validation: Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler. AC stays in the catalog but isn't a primary launch type. These are **testable operating assumptions**, not proven demand | `catalog.service_categories` / `service_types` + city-scoped `service_rules.enabled` |
| State law | Andhra Pradesh: check any state platform-worker/gig-worker law, shops & establishments registration, police verification practice for home-service workers ⚖️ | — |

### 9.1 Catalog scope (revision 2026-10-08)
- V1 category tree and specializations: [Phase 1 03 §8.1](../phase-1/03-database.md#81-v1-catalog-tree-seed-example). Decision record: [ADR-020](../phase-1/15-architecture-decisions.md#adr-020-appliance--home-equipment-replaces-standalone-ac).
- **No generic "appliance technician".** Skills stay per service type + specialization with `can_diagnose` / `can_repair` and verification level. Example: a refrigerator gas-charging repair needs `REFRIGERATOR.GAS_REFRIGERATION`.
- Which appliance service types stay enabled after the pilot is decided by pilot demand + technician supply data (manual pilot H9), through config with no code change.
- The non-AC validation example is **"Refrigerator not cooling"** (Phase 1 02 §3.1). The AC example remains as a diagnosis/repair reference and regression scenario.

### 9.2 Localization architecture (Hindi or others addable without code changes)
- **Locale is data:** `cities.supported_locales`, per-user `preferred_locale`/`ivr_locale`. **Remove the hard-coded `DEFAULT 'hi-IN'`** in Phase 1 `identity.users` (X-05). The default comes from the city's configured primary locale at registration.
- **UI strings:** ICU MessageFormat catalogs per locale, loaded by key. CI checks for missing keys. Pseudo-locale testing for truncation (Telugu script is wider/taller: line-height and font, e.g., Noto Sans Telugu, subsetted).
- **Numbers:** Western digits with Indian grouping (₹1,25,000) by default. Telugu numerals are not used (configurable per locale).
- **IVR prompts:** prompt catalog keyed by `(prompt_id, locale, version)`. Pre-recorded by native speakers. Number/amount/time clips per locale. Locality name clips per locale. Brand clip separate. **Telugu TTS/ASR quality is a known risk:** pre-record more, keep ASR off by default for Telugu until the field test shows acceptable accuracy.
- **Locale enablement gate:** a locale can be enabled for a city only when UI catalog coverage = 100%, IVR prompt coverage = 100% for enabled flows, notification templates are approved (DLT/WhatsApp) per locale, and a native-speaker review is signed off. Enabling is a config change (maker-checker).
- **Fallback:** UI falls back to `en-IN` for missing keys (and logs a metric). **IVR never mixes languages inside a flow.** A missing prompt blocks enablement instead.
- **Language switching:** offered at the IVR greeting for inbound calls and as a hotline menu option that updates `ivr_locale` (X-31). Available on every PWA/app screen header.
- **Adding Hindi later:** add the locale to the city config, upload catalogs/recordings, register templates. **No code change.**
