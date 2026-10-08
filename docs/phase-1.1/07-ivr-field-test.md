# Phase 1.1 · 07 — IVR Field Test Plan (Basic-Phone Technicians)

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Purpose: prove (or disprove) that basic-phone technicians in the Kurnool region can complete every critical IVR task **unaided**, before the voice module is built at scale. This is a **prototype dependency** for the Phase 2 gate.

---

## 1. Format

| Round | What | Participants | Duration |
|---|---|---|---|
| **R0: Wizard-of-Oz** (week 1) | A researcher plays the IVR live by phone, reading scripted Telugu/English prompts and logging keypresses manually. Validates wording, menu order and comprehension cheaply | 6–8 technicians | 2–3 days |
| **R1: Real IVR prototype** (weeks 2–3) | Flows built on the shortlisted telephony provider(s) **as a disposable prototype** (provider flow builder or minimal throwaway webhook). Synthetic jobs. No real customer data | **≥ 12 technicians** (≥ 10 required) | 1–2 weeks |
| **R2: Re-test after fixes** (week 4) | Same tasks with revised prompts. Includes 4 new participants to avoid learning bias | 8+ | 3–4 days |

The R1 prototype is **throwaway**. It doesn't become production code.

---

## 2. Participants (minimum 12 for R1)

| Dimension | Required spread |
|---|---|
| Phones | ≥ 6 basic keypad phones of different makes (e.g., common ₹1,000–2,000 feature phones, a 4G feature phone, an older 2G keypad phone). ≥ 2 low-end Android phones used via the IVR (technicians who'd rather call than use apps) |
| Network | ≥ 3 participants tested in weak-signal conditions (edge of town/indoors/basement). ≥ 2 on 2G-only devices. Test at noisy sites (a workshop, the roadside) |
| Languages | Telugu-dominant (majority), ≥ 2 comfortable in English, ≥ 2 whose first language is Urdu or Kannada (to measure comprehension of Telugu/English flows. **Not** to add languages) |
| Literacy | ≥ 3 who can't read SMS fluently. ≥ 3 who read Telugu only. Mixed |
| Age | ≥ 3 aged 45+. ≥ 1 aged 55+. ≥ 3 under 30 |
| Gender | Include women technicians if any are available in the network (also gathers safety feedback) |
| Trade | Plumbers, electricians and appliance technicians covering the selected appliance service types (e.g., refrigerator, RO/water purifier, washing machine). No fixed quota per appliance type |

Ethics & privacy: informed consent (spoken, in their language), **paid for their time** (fixed participation fee, not tied to performance), synthetic jobs only, recordings of research sessions only with explicit consent and stored per the pilot data SOP, the right to stop at any time.

---

## 3. Tasks & scripts (each run on a synthetic job)

| # | Task | Success definition |
|---|---|---|
| 1 | **Job offer:** answer the call, confirm identity, understand the offer | Can state the service, area, time and earnings when asked afterwards |
| 2 | **Accept** (with double confirmation) | Offer accepted in the system |
| 3 | **Reject** a second offer (with optional reason) | Declined. No accidental accept |
| 4 | **Repeat** details | Uses key 3 at least once when asked to "hear it again" |
| 5 | **Set and use PIN** (set in an onboarding call. Use later) | PIN set (not trivial). Used successfully on the first or second attempt |
| 6 | **Address playback** (hotline → PIN → visit selection → address) | Can repeat the synthetic address/landmark back correctly |
| 7 | **Customer call bridge** (hotline option → PIN → bridge to a researcher acting as the customer) | Connected to the "customer" |
| 8 | **Arrival** (enter the customer's 4-digit code read by the researcher) | Arrival recorded on the correct visit |
| 9 | **Diagnosis support** (request the diagnosis desk, describe the problem to a researcher-agent) | Connected. The diagnosis is captured |
| 10 | **Completion** (completion code + material question + cash/online choice + cash confirmation) | Completion and cash recorded with the right amount |
| 11 | **Earnings** summary | Can state this week's amount and next payout date |
| 12 | **SOS** | Reaches the "safety desk" (researcher) **without menus**, in ≤ 15 s |
| 13 | **Language switching** (switch from Telugu to English and back via greeting/hotline option) | Preference changed and persists on the next call |
| 14 | **Call drop recovery** (researcher drops the call mid-acceptance and mid-address) | Technician calls back and completes. No duplicate/lost state |
| 15 | **Wrong keypad input** (instructed task where a mistake is likely, plus natural errors) | Recovers through the re-prompt without agent help |
| 16 | **Daily check-in via missed call** | Callback received. Availability + area recorded |

The order is randomised for tasks 3–11 to reduce learning effects. Synthetic jobs span all three categories, including at least one non-AC appliance job (e.g., "Refrigerator not cooling" or "RO not working"), so that service-type names, appliance-specific diagnosis-desk flows and service-type-specific repair codes are tested.

---

## 4. Metrics

| Metric | Definition | Captured by |
|---|---|---|
| **Completion rate** | % of task attempts completed unaided (no researcher hint, no agent) | System log + observer |
| **Time per action** | From call answer (or menu start) to task success | System timestamps |
| **Error rate** | Invalid/timeout inputs per task attempt | `ivr_interactions` log |
| **Call drop rate** | Calls ended by network failure / all calls (separated from user hang-ups) | Provider CDRs |
| **Misunderstanding rate** | % of tasks completed but the post-task comprehension question was answered wrongly (e.g., accepted but can't say the time) | Observer questionnaire |
| **Agent escalation rate** | % of task attempts where the participant pressed 9 or needed agent help | Logs + observer |
| Accidental action rate | Unintended accept/decline/arrive | Logs vs. instructions |
| PIN lockouts | Count | Logs |
| Satisfaction / trust | 5-point smiley scale + "would you use this daily?" | Interview |
| Latency | IVR step response p95 (end-to-end, observed) | Prototype telemetry |

---

## 5. Pass/fail thresholds (R1 → must pass by R2)

| Metric | Pass threshold |
|---|---|
| SOS reached in ≤ 15 s | **100%** of attempts (any failure = fail and redesign) |
| Accept, arrival, completion, address playback: unaided completion | **≥ 90%** each |
| Reject, repeat, earnings, check-in, language switch: unaided completion | ≥ 85% each |
| Diagnosis desk connection | ≥ 90% (excluding agent-unavailability simulations) |
| **Accidental accept/decline** | **0** with double confirmation (≤ 1 occurrence across all participants triggers a review) |
| Misunderstanding rate on offer details (service, area, time, earnings) | ≤ 10% |
| Median time: offer answer → accepted | ≤ 75 s |
| Median time: hotline → address heard (incl. PIN) | ≤ 60 s |
| Median time: arrival code entry | ≤ 45 s |
| Error rate per task (invalid/timeout inputs) | ≤ 0.5 per attempt (median) |
| Agent escalation rate | ≤ 10% of attempts |
| Network call-drop rate | Recorded. Pass if **recovery** succeeds ≥ 95% (we can't control network drops) |
| PIN lockouts in normal use | 0 |
| Participants "would use daily" | ≥ 70% |
| IVR step latency p95 (Mumbai region → provider) | < 800 ms |

**Fail handling:** any failed threshold → redesign prompts/flows → retest in R2. If accept/arrival/completion stay below 80% after R2, **escalate to the founder**: consider agent-first operation for basic-phone technicians in the pilot and revisit ADR-005 scope.

---

## 6. Observation protocol
- One observer per participant (Telugu-speaking), using a structured sheet: task, start/end, hesitations, errors, quotes ("what were you expecting here?").
- Think-aloud is **not** forced (unnatural on a phone). A short debrief follows each task.
- Comprehension questions after tasks 1, 6, 10, 11.
- Environmental notes: noise level, signal bars, handset model, whether glasses were needed, hands occupied.

---

## 7. Interview questions (after the session)
1. Which part was confusing? Which part was easy?
2. Was the voice clear? Speed OK? Would you prefer a male/female voice, or a different Telugu style?
3. Is the 4-digit PIN OK? Would you remember it? Where would you write it down? (Note the security implications.)
4. Would you trust that the job and earnings are real? What would make you trust it more?
5. What time of day do you want job calls? How many calls a day is too many?
6. Would you pay for calls if the number weren't toll-free? (Expected: no. Confirms the toll-free requirement.)
7. How do you get addresses today? Is hearing the address on a call OK?
8. Who helps you with phone things today? Would you use an agent?
9. What would make you stop using this?

---

## 8. Outputs
- Task-level results table vs. thresholds. A prioritised list of prompt/flow changes.
- Updated IVR state machines (Phase 1 08) with the evidence.
- Telephony provider comparison (latency, webhook authenticity: **SR-01**, DTMF masking SR-12, call quality, failover).
- Go / redesign / escalate recommendation.

---

## 9. Customer-side IVR mini-test (for D-12)
With ≥ 8 customers (≥ 3 aged 55+, ≥ 3 low-literacy): quote approval call (F4a), cash confirmation (F4b), door-code delivery call. Measure understanding of the amount and of what they approved, accidental approvals, and comfort with a ₹2,000 limit. **D-12 stays provisional until this passes** (≥ 90% correct understanding of the amount, 0 accidental approvals).
