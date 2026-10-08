# Phase 1.1 · 04 — Customer Journey Review

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Method: walk the designed journey (Phase 0 §6 + Phase 1 04/06) as each persona, in the Kurnool pilot context (Telugu/English, low-end Android, patchy data, WhatsApp-heavy). Each issue is tagged **V1** (fix before pilot), **V1.1** (fix soon after) or **Later**.

---

## C1. First-time smartphone user

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C1-1 | Login (OTP) is deferred to the end of booking, so the user may hit an OTP failure after investing effort | Abandonment at the last step | Keep deferred login, but save the draft locally. If OTP fails → offer "Call me to complete booking" (ops callback) with the draft attached | V1 |
| C1-2 | Abstract terms: "visit fee", "quote", "approve", "start code" | Not understood → distrust or wrong actions | Plain Telugu wording tested with users (e.g., "check-up charge", "repair price", "say yes to the price", "4-digit door code"). Icons + a short voice explanation (🔊 button reads the screen aloud) | V1 |
| C1-3 | PWA "install" prompt confuses | Unknown pattern | Don't prompt install on the first visit. Offer it after the first completed job ("Add to home screen for next time") | V1 |
| C1-4 | Map pin selection is hard | Wrong location | Locality search + landmark text first. Map pin optional ("Use my location" with a clear consent explanation) | V1 |

## C2. Older customer (60+)

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C2-1 | Small text, fast timers (quote expiry, offer countdowns shown to customers) | Can't keep up | Default font 18 px, respect system font scaling. No visible countdowns for customers. Generous quote expiry (48 h) | V1 |
| C2-2 | Prefers to talk to a human | App-only flows exclude them | The booking phone line is first-class. "Call me" on every screen. Ops-assisted booking + IVR approval call | V1 |
| C2-3 | Reading codes aloud to a technician through a closed door | Safety anxiety | Code delivered by SMS and an IVR call ("Your door code is 4-7-2-9"). Customer copy: "Ask to see the technician's photo in the app/SMS first" | V1 |
| C2-4 | Family member manages bookings remotely (son in another city) | The person at home isn't the account holder | "Booking for someone else" with an on-site contact (name + phone, consented by the booker). Codes/approvals can go to the on-site contact by the booker's choice. *Privacy: the on-site contact's number is stored as C, encrypted* | V1.1 |

## C3. Low digital literacy

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C3-1 | Typing the address in English/Telugu | Spelling errors, incomplete addresses | Voice note for the address + landmark (ops transcribes when needed). Recent addresses one tap | V1 (voice note) |
| C3-2 | Itemised quote is overwhelming | Can't judge it → rejects or approves blindly | Show **one total in large type**, then "What's included" expandable. 🔊 read-aloud. A "Call me to explain" button that bridges the technician or ops | V1 |
| C3-3 | Payment links / UPI intents fail on some phones | Payment friction | UPI QR shown on the **technician's app screen** for scanning with any UPI app (amount fixed), *plus* the customer link. Cash allowed | V1 |
| C3-4 | WhatsApp vs SMS confusion: messages from many numbers | Ignored or untrusted messages | One verified WhatsApp Business sender + one DLT SMS header, consistent brand name (config) | V1 |

## C4. Woman booking a technician

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C4-1 | Safety concern about a stranger entering | Won't book, or books with fear | Before arrival: technician photo, verified badges, "Is this the person at your door?" check, SOS visible, share-trip-details with a family member (SMS of job status, no technician phone) | V1 (share = V1.1) |
| C4-2 | Wants a woman technician | Very limited supply. Founder: opt-in, explicit, scoped | Not in V1 (supply + DPIA). Record interest anonymously in pilot interviews | Later |
| C4-3 | Customer's number exposed to the technician | Harassment after the job | Masked calls only, binding expires (already). The technician can't see past jobs. A "block this technician" option | V1 |
| C4-4 | Reporting harassment feels risky | Under-reporting | Discreet reporting path (no technician notification until safety review), women safety officers where possible, follow-up call option | V1 |

## C5. Urgent plumbing issue (water leaking now)

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C5-1 | The two-visit model is too slow for emergencies | Customer goes to a local plumber instead | Emergency service types (e.g., "Major leak / no water") **default to same-visit-eligible** with technicians carrying common materials. Matching prioritises `can_repair` technicians for the diagnosis visit | V1 |
| C5-2 | "Finding technician" with no ETA | Anxiety | Show an honest range ("usually 30–60 min in your area") and immediate interim advice ("Turn off the main valve: how?", short picture guide) | V1 |
| C5-3 | Night emergencies vs quiet hours | No help at 10 PM | V1: honest message ("Night service not available yet. Emergency numbers / call us at 7 AM"). Later: opt-in night technicians | V1 copy / Later service |
| C5-4 | Visit fee feels unfair for a 5-minute fix | Disputes | Clear upfront fee + the pricing model choice (D-07) | V1 |

## C6. Customer who doesn't know the technical problem

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C6-1 | Category choice: is "fridge not cooling" or "no water from the RO" an electrical, plumbing or appliance problem? | Wrong category → wrong technician | Symptom-first entry ("What's happening?") with pictures across categories. The system maps to the category. "Not sure" → ops callback | V1 |
| C6-2 | Can't judge whether the diagnosis is honest | Trust | Diagnosis shows photos (when available), a plain explanation, reference price range ("Typical: ₹300–₹600 in Kurnool"), and "Get a second opinion" (reject without penalty beyond the visit fee) | V1 |
| C6-3 | AI suggestion wrong | Misrouting | AI suggestion is a pre-selected chip only, always confirmable/changeable. Off by default in the pilot (SR-15 for voice) | V1 (off) |
| C6-4 | Doesn't know the appliance type/brand/model (e.g., RO model, top- vs front-load washing machine, direct-cool vs frost-free fridge) | Wrong specialization or parts → extra visit | Optional "photo of the appliance/label" step with picture examples. The technician confirms the details at diagnosis. Never required to book | V1 |

## C7. Customer disputing a price

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C7-1 | "The technician asked for more cash than the bill" | Trust breach | The bill on the customer's own phone is the only valid amount. Prominent copy: "Never pay more than ₹X shown here". A one-tap "I was asked to pay more" → P2 complaint + ops call within service hours | V1 |
| C7-2 | Material price seems inflated | Disputes | Reference price shown per material line. Receipts above the threshold visible to the customer | V1 |
| C7-3 | Dispute process opaque | Frustration | Status timeline for complaints, an expected decision date, both sides heard, and the outcome explained | V1 |
| C7-4 | Refund timing unknown | Anxiety | Show the refund status + typical bank timelines. SMS on completion | V1 |

## C8. Customer reporting damage (e.g., broken tile, burnt appliance)

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C8-1 | No damage category or evidence flow | Unhandled liability | Complaint category `PROPERTY_DAMAGE` with photo upload, time-bound reporting window (e.g., 72 h), and a damage-claim workflow (investigation → goodwill/insurance partner later) ⚖️ liability terms | V1 (category + workflow), Later (insurance) |
| C8-2 | No "before" evidence | He-said-she-said | Before photos encouraged on arrival (app technicians) and customer-side photos (link) for IVR jobs (X-29) | V1 |
| C8-3 | Terms on liability unclear | Legal exposure | Clear terms of service: platform role, technician responsibility, claim caps ⚖️ | V1 (legal) |

## C9. Customer who wants the same technician again

| # | Problem | Why it matters | Recommended UX | When |
|---|---|---|---|---|
| C9-1 | No "rebook" for new jobs | Customers go offline to call the technician directly (disintermediation) | "Book {technician first name} again" on past jobs → a direct offer (with fallback consent), honouring the technician's availability. Better than off-platform, because warranty and protection come with it | V1.1 |
| C9-2 | Technician unavailable → customer disappointed | — | Show availability honestly. Offer the next slot with that technician or another verified technician | V1.1 |

---

## Cross-cutting fixes promoted to V1 (spec changes)
1. Symptom-first booking with an "I'm not sure" path to an ops callback (C6-1).
2. 🔊 read-aloud on key screens (quote, codes, status) in Telugu/English (C1-2, C3-2).
3. UPI QR on the technician screen, fixed to the bill amount (C3-3).
4. Emergency service types eligible for same-visit repair by default (C5-1). This **does not change the architectural default**. It's a service rule.
5. `PROPERTY_DAMAGE` complaint workflow (C8-1).
6. "Who will be home" and adult-present policy (X-34).
7. Customer photos for IVR-technician jobs (X-29).
8. No numeric SOS response promises until staffing is confirmed (X-33).
