# Phase 2 · 05 — First Vertical Slice Specification

> Status: **DRAFT for founder approval** · Date: 2026-10-08
> **Supersedes** the slice description in Phase 1 README §12. Runs **only in `dev`/`test`/`staging`** with synthetic data, sandbox payments, the IVR simulator (real provider sandbox numbers only after Spike S-1), fake SMS/push, and no production KYC.

---

## 1. Shared fixtures (synthetic)
- City: **Kurnool (PILOT, test config)** with 2 **synthetic** zones and ~12 synthetic localities (fictional names, adjacency graph).
- Locales: te-IN, en-IN.
- Catalog: Plumbing (`PLUMBING_GENERAL`), Electrical (`ELECTRICAL_GENERAL`), Appliance & Home Equipment (`REFRIGERATOR`, `RO_WATER_PURIFIER`, `WASHING_MACHINE`, `GEYSER`, `AIR_COOLER` enabled. `AC` enabled **in the test city only** for the regression scenario).
- Rate cards: **two fixture configs, Model B and Model C** (test values only, flagged NOT FINAL). No tax rules active.
- Technicians (synthetic): T-PLB-1 plumber (app), T-PLB-2 plumber (app), T-ELE-1 electrician (**basic phone**), T-FRG-1 refrigerator technician (app, specializations COOLING, THERMOSTAT. **No** GAS_REFRIGERATION), T-FRG-2 refrigerator specialist (app, GAS_REFRIGERATION, ASSESSED), T-RO-1 RO technician (app, used as a negative matching control), T-AC-1 AC technician (app, COOLING + ELECTRICAL).
- Customers (synthetic): C-1…C-4 with verified phones (fake numbers in a reserved test range).
- Warranty policies: per repair item (fixtures).

## 2. Scenario 1: PLUMBING ("Kitchen sink leaking under the counter")
| # | Step | System behaviour / assertion |
|---|---|---|
| 1 | C-1 opens the PWA (te-IN), picks Plumbing → symptom "Leak under sink", address + landmark, "Me" at home, ASAP, payment preference Either | Catalog API returns only enabled types. Booking request carries `clientRequestId` + Idempotency-Key |
| 2 | Sees the visit fee (fixture) and "no work without your approval". Confirms. OTP login | Job + diagnosis visit V1 PLANNED. A double-submit creates one job |
| 3 | Matching | Pool has only PLUMBING technicians with `can_diagnose`. Exclusive offer to the top-ranked plumber. Explanation logged |
| 4 | T-PLB-1 slide-to-accepts | TCP-1: offer ACCEPTED + assignment ACTIVE atomically. Concurrent accept by another device → `OFFER_NO_LONGER_AVAILABLE` |
| 5 | Depart → arrive with door code | L2 opens only now (customer verified). Disclosure event logged. Wrong code ×5 → locked + ops alert (separate test) |
| 6 | Diagnosis: worn trap + pipe joint, material not carried | Diagnosis SUBMITTED (immutable). Server-priced Quote v1 PRESENTED. Content hash |
| 7 | C-1 sees the quote: qualified technician → "Fix it now" not offered (material not available) → **"Same technician, later"** primary, specialist as a quiet link. Approves | Approval bound to the hash. RO created. Repair visit V2 PLANNED |
| 8 | Repair visit scheduled (slot), T-PLB-1 direct offer → accepts | Direct offer. G-3: T-PLB-1 still receives unrelated ASAP offers for non-overlapping windows |
| 9 | Depart, arrive (new door code), repair, completion code, materials used (≤ quoted) | **TCP-3**: bill issued in the completion transaction. The app shows the amount due. Ledger posting async (worker) |
| 10 | C-1 pays by UPI in the **PA sandbox** | Webhook verified + server fetch. Payment CAPTURED. Ledger balanced. Bill PAID |
| 11 | Receipt placeholder | PDF watermarked "TEST: NOT A TAX INVOICE" (programmatic PDF) |
| 12 | Job CLOSED. Warranty coverage created per repair item. C-1 rates T-PLB-1 | INV-22, INV-16 |

## 3. Scenario 2: ELECTRICAL ("Frequent tripping in one room"): basic-phone technician + IVR simulator + ops desk
| # | Step | Assertion |
|---|---|---|
| 1 | C-2 books Electrical, payment preference **Cash**, "Adult family member" at home + on-site contact | Booking with on-site contact encrypted |
| 2 | Matching → T-ELE-1 (basic phone) | H18: T-ELE-1 is not cash-capped (a separate test puts a capped technician on a CASH visit → excluded) |
| 3 | **IVR simulator** offer call: greeting with a language switch, ID check, offer details (L0 only), `1` → confirm `1` | Offer **held** during the call (G-2). Acceptance at second 290 succeeds. Confirmation SMS (fake) has **no address** |
| 4 | Hotline → PIN → visit read-back → address playback (L2) | Disclosure event. PIN masked in `ivr_interactions` |
| 5 | Depart (read-back + confirm), arrive (door code via DTMF) | Presence proof |
| 6 | "Diagnosis batana hai" → **ops diagnosis desk** (admin console, simulated bridge) | Ops agent captures the diagnosis from the ELECTRICAL catalog (MCB replacement, part not carried). Quote v1 presented to the **customer's** PWA |
| 7 | C-2 approves "Same technician, later" | Separation of duties: the ops capturer can't record any approval (and the ops-recorded channel is flag-off anyway) |
| 8 | Repair visit: IVR material check ("saamaan le liya? 1") → depart → arrive → completion code via IVR | TCP-3 bill. The IVR reads the amount due |
| 9 | Technician presses cash `1` → confirms amount | Cash collection recorded (fixed = amount due). Customer confirmation request (PWA) → confirmed → ledger cash-held netting (worker) |
| 10 | Close, warranty, rating | — |
| **Security** | Forged simulator events (accept/arrive/complete/cash-confirm) with bad signature/nonce/ended call/foreign SID | **All rejected** + alerts. No state change |

## 4. Scenario 3: APPLIANCE ("Refrigerator not cooling")
| # | Step | Assertion |
|---|---|---|
| 1 | C-3 books Appliances → **Refrigerator** → "Not cooling" | Catalog is category-based. No AC-specific code path |
| 2 | Matching | Eligible: T-FRG-1, T-FRG-2 (REFRIGERATOR + `can_diagnose`). **T-RO-1 and T-AC-1 never offered** (skill specificity test) |
| 3 | T-FRG-1 diagnoses: gas leak / low refrigerant → requires `GAS_REFRIGERATION` (T-FRG-1 lacks it) | Quote v1. Repair options: **"Book recommended specialist" only** (Q-A), with copy explaining the technical requirement |
| 4 | C-3 approves | RO with required specialization. Repair visit matched on REFRIGERATOR + REPAIR + GAS_REFRIGERATION → T-FRG-2 |
| 5 | T-FRG-2 repair (app): materials confirmed, completion code | TCP-3 bill |
| 6 | UPI sandbox payment | Ledger: diagnosis payout to T-FRG-1 (INV-23) + repair share to T-FRG-2 |
| 7 | Warranty per repair item (gas charge vs leak fix policies) | Coverage snapshot |
| 8 | C-3 rates T-FRG-1 and T-FRG-2 separately | Per-technician ratings |

## 5. Scenario 4: AC regression ("AC not cooling"): same visit + price change
| # | Step | Assertion |
|---|---|---|
| 1 | C-4 books Appliances → AC (enabled in the test city) | AC is supported as a service type |
| 2 | T-AC-1 diagnoses: capacitor fault, part carried, qualified | Quote v1 with **"Fix it now"** primary (same visit), "Same technician, later" secondary, specialist quiet link |
| 3 | C-4 approves "Fix it now" | Visit purposes become [DIAGNOSIS, REPAIR]. Completion code issued |
| 4 | Mid-repair: a second fault (indoor wiring) → **Quote v2** | RO CHANGE_PENDING. Completion is blocked until decided. v2 shows "was ₹X, now ₹Y" |
| 5 | C-4 approves v2 → completion | v1 SUPERSEDED. The bill equals v2 (+ policy fees). Sandbox payment. Warranty. Rating |

## 6. Cross-cutting acceptance criteria (Gate 12)
- Scenarios 1–4 automated: Playwright (PWA, admin), Maestro (technician app), IVR simulator scripts. Plus one **staging** run with real provider **sandbox** numbers **only if S-1 has passed** (otherwise simulator-only, recorded as a condition).
- Invariant suite green: INV-01…INV-28 where applicable, ledger L1–L10.
- AuthZ matrix green for every slice endpoint (customer, technician, agent stub, admin roles).
- Restart safety: kill the worker during the cascade and during bill posting → recovery within SLA, no duplicates.
- Idempotency: 5× duplicate booking/accept/complete/cash submissions → single effects.
- Canary-PII: 0 hits in logs/traces/errors.
- Performance: slice endpoints within SLO under 5× pilot-like synthetic load in staging. IVR step p95 < 800 ms.
- Fitness: no cross-schema access outside TCP-1/2/3. No ledger writes outside the worker.
- UI: Gate 8/9 accessibility and performance budgets met for the slice screens.
- Demo to the founder + phase review.

## 7. Explicitly out of scope for the slice
Waves · rebook-favourite · reschedule UI (API only) · complaints/disputes UI (API stubs) · warranty claims (coverage creation only) · refunds UI (admin API + sandbox only) · payout execution (preview only) · WhatsApp (fake SMS only) · women-segment ratings · Care Visit · benefits · real KYC · production telephony · live payments · tax lines · AI beyond flagged fakes · multi-city · field-agent onboarding UI (seed data).
