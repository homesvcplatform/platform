# Phase 1.1 · 05 — Technician Journey Review

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Lenses: **unfairness · unnecessary friction · privacy · earnings · safety · technology barriers.** Tags: **V1** / **V1.1** / **Later**.

---

## T1. Button-phone plumber

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Friction | PIN + visit read-back + code entry + material questions = long calls (cost and patience) | Measure time per action in the field test. Remember the PIN for 10 min within a call (designed). Shortest prompt variants after first use ("expert mode" prompts, same confirmations) | V1 |
| Earnings | Unanswered offer calls while working (hands busy, noisy) → missed jobs | Unreachable ≠ decline (designed). Offer call **retry + a missed-call callback** ("give a missed call to hear your offers"). Scheduled offers in the preferred call window | V1 |
| Tech barrier | Can't receive photos/quotes. Diagnosis needs the ops desk | Ops desk capacity is a dependency (measured in the pilot). Keypad repair codes (V1.1) | V1 / V1.1 |
| Unfairness | No photo evidence → weaker in disputes (X-29) | Dispute policy explicitly doesn't penalise missing photos for IVR technicians. Customer-side photos | V1 |
| Cost | Calling the hotline to hear the address costs money? | **Toll-free hotline**, missed-call callbacks (designed). Confirm the toll-free numbering with the provider | V1 |

## T2. Low-end Android appliance technician (e.g., refrigerator/AC)

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Tech | Battery optimisation kills the app. Offers missed (Android 14 / OEM) | Onboarding step (agent-assisted) to whitelist the app. Push → IVR fallback after 45 s. Device-lab validation ([08](08-device-test-matrix.md)) | V1 |
| Friction | Diagnosis builder with many chips on a small screen | Top-10 repairs per category first. Search by voice. Quantity steppers. Draft autosave offline | V1 |
| Data cost | Photo uploads on a limited data pack | Compress to ≤ 200 KB. Upload on Wi-Fi option. Show data used | V1 |
| Earnings | Doesn't understand why a quote was rejected | Show the customer's reason category (no PII) and their own approval rate vs. peers (anonymous aggregate) | V1.1 |

## T3. Female electrician

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Safety | Entering unknown homes. Late slots | Technician-side restrictions (no late slots, preferred zones) as hard filters (H12). SOS. **Technician can see the customer's verified status** (phone-verified, prior completed jobs count, no safety flags) before accepting. Leave without penalty if uncomfortable | V1 |
| Privacy | Her photo and name visible to customers. Stalking risk | Photo optional for technicians who opt out on safety grounds (verified badge still shown). First name only. No areas below zone level (C-15) | V1 |
| Unfairness | Customers' bias in ratings | Ratings excluded from aggregates when flagged abusive. Bayesian smoothing. Appeal path. Monitor rating distributions by technician gender (aggregate, internal) for bias, **never** used in ranking | V1 (monitoring V1.1) |
| Harassment reporting | Fear of retaliation | Confidential reporting. Customer blocked from re-booking her. Safety officer follow-up | V1 |

## T4. Technician who gets few jobs

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Unfairness | Opaque ranking | "Why am I not getting jobs?" screen/IVR summary: eligible hours, offers, acceptance, and actionable tips (check in daily, add a secondary area, complete skill verification). Fairness term + parity monitor (designed) | V1 |
| Earnings | Low earnings → churn | Weekly earnings report. Agent outreach when the opportunity deficit persists > 2 weeks | V1.1 |
| Lock-in | Probation daily cap keeps new technicians low | Cap lifts automatically after N good jobs. Visible progress ("3 more jobs to full access") | V1 |

## T5. Technician who travelled and the customer cancelled

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Earnings | Compensation depends on evidence (D-14). IVR technicians have weaker evidence | Evidence ladder allows E2 via **masked-call attempts or an ETA confirmation call** (no GPS needed) (X-28). Show the expected compensation immediately with "pending review 72 h" | V1 |
| Unfairness | Customer contests ("never came") | Dispute weighs call logs, departure time, travel plausibility. The technician is heard. No clawback without a decision | V1 |

## T6. Technician accused of overcharging

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Unfairness | Accusation affects metrics before investigation | Only **upheld** complaints count (designed). Evidence pack auto-built: approved quote hash, cash amount recorded = bill, customer confirmation | V1 |
| Privacy | Technician named in internal notes | Investigation notes are Restricted. Outcome communicated in their language | V1 |
| Protection | A fixed cash amount and the customer's own bill protect the honest technician | Emphasise in training: "Collect exactly the app amount" | V1 |

## T7. Technician receiving a false complaint

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Unfairness | Suspension before hearing | Interim suspension only for credible **safety** allegations, ≤ 72 h, with a reason given and a paid-out balance not frozen (except the disputed amount). Appeal to a different reviewer | V1 |
| Earnings | Loss during interim suspension | If the complaint is not upheld, offer a priority boost in the fairness term for 2 weeks (a goodwill payment is a founder decision) | V1.1 |
| Pattern | Serial false complainants | Bad-faith reporter review. Customer block | V1 |

## T8. Technician whose phone breaks

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Earnings | New device → payout hold (Phase 1) | Hold only when combined with a payout change or integrity failure (X-32). Show the reason and release time | V1 |
| Continuity | Mid-visit phone failure | Complete via any phone through the IVR (PIN + customer code) or ops (designed). Same number on a new SIM → OTP works | V1 |
| Access | Can't get OTP (SIM lost) | Agent-assisted recovery (05 §7). Temporary IVR-only mode from a family member's phone with PIN + agent verification | V1 |

## T9. Technician with poor internet

| Lens | Issue | Recommendation | When |
|---|---|---|---|
| Tech | App actions fail | Offline queue (designed). **Every app action has an IVR equivalent** (designed parity), so poor data means switch to a call | V1 |
| Earnings | Offer push not received | PUSH_THEN_IVR (designed) | V1 |
| Friction | Photo uploads stuck | Background resumable uploads. Visit completion doesn't wait for photo upload (photos attach later within 24 h) | V1 |

---

## Systemic findings
1. **Ops-desk dependency for basic-phone diagnosis** is the biggest friction and cost point. Measure it in the manual pilot (target ≤ 8 agent-minutes per diagnosis). Prioritise keypad repair codes (V1.1).
2. **Evidence asymmetry** between app and IVR technicians must be neutralised in dispute and compensation policies (X-28, X-29).
3. **Holds and caps must always be explained** with amounts, reasons and release dates (D-13, X-32).
4. **Safety for technicians** needs the customer-verification signal before accept, and a no-penalty exit (V1).
5. **Fairness transparency:** a technician-facing explanation of opportunity (V1) builds trust in the algorithm.
6. **Appliance skills are specific** (catalog revision, ADR-020): onboarding records skills per appliance service type and specialization (e.g., refrigerator gas/refrigeration vs. thermostat), verified by trade test. Technicians aren't penalised or shown as "declining" for offers outside their declared service types, because they never receive them.
