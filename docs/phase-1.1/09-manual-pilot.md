# Phase 1.1 · 09 — Manual (Concierge) Pilot Plan

> Status: **DRAFT for founder review** · Date: 2026-10-08
> A real-world pilot run with phones, WhatsApp and a controlled database before the platform exists. **Every job follows the same product logic as the future software** (booking → assignment → visit → diagnosis → quote → approval → repair → payment → warranty → rating), so the data and lessons transfer directly. ⚖️ = needs legal/CA input before starting.

---

## 1. What the pilot must answer (hypotheses)

| # | Hypothesis | Evidence that confirms/refutes it |
|---|---|---|
| H1 | Customers accept a diagnosis-first model with a visit/inspection fee | Booking conversion. Rejection reasons. Interviews |
| H2 | Customers approve itemised quotes at a healthy rate and return for separate repair visits | Approval rate. Drop-off between approval and repair visit |
| H3 | Basic-phone technicians can operate through calls/agents with acceptable ops cost | Desk minutes per diagnosis. Error/escalation rates |
| H4 | Technicians find earnings fair and transparent | Earnings per active day vs. their current baseline. Interviews. Retention |
| H5 | Pricing model B or C produces non-negative CM on repair jobs with real costs | Measured costs per job ([06](06-pricing-and-unit-economics.md)) |
| H6 | Safety and trust measures (verified technicians, door codes, masked calls) are understood and valued | Usage. Incidents. Interviews |
| H7 | Zone/locality matching works without GPS | Time-to-assign. Travel times. No-shows |
| H8 | Specialist hand-off (different technician for repair) is operationally feasible | Hand-off share. Time to repair visit. Complaints |
| H9 | The selected appliance service types (Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler) have enough demand and technician supply in the pilot zones. This is an operating assumption to test, not proven demand | Bookings and enquiries per service type (including requests for **non-enabled** types such as AC, TV, inverter). Supply per service type/specialization. Fill rate per service type |

---

## 2. Scope

| Item | Plan |
|---|---|
| City | Kurnool, Andhra Pradesh |
| Zones | **2 zones initially** (dense residential, reachable supply), a third added in week 5 only if KPIs are healthy. Zone boundaries drawn on a map and mapped to locality lists (becomes `geo` seed data) |
| Categories | Plumbing, Electrical, **Appliance & Home Equipment** (ADR-020). Appliance service types enabled for validation: Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler. AC is in the catalog but not a primary launch type (requests are logged and can be enabled by config) |
| Technicians | **40–80 recruited, target 50 active**: ≥ 30% basic-phone, mixed trades. **No fixed quota per trade or appliance type:** the mix is set from observed plumbing, electrical and appliance-service demand (enquiry data from setup weeks), actual technician availability, and the selected appliance service types. Recruitment is reviewed weekly against fill rate per service type |
| Customers | Real households in the zones. Target **≥ 400 bookings** and **≥ 250 completed jobs** across the pilot |
| Money | Real money ([§6](#6-money-handling-interim-pending-d-08-)) |
| Languages | Telugu + English (all scripts, messages and receipts) |
| Hours | 8 AM–8 PM, 7 days (no night service). Honest copy about hours |

---

## 3. Timeline (12 weeks)

| Weeks | Activity |
|---|---|
| −3 to −1 (setup) | Legal minimums (§5). Recruit + verify + train technicians. Zone mapping. Repair catalog v0 + reference prices (from technician interviews and local shops). Scripts and templates in Telugu/English. Ops tooling set up. IVR field test R0/R1 runs in parallel with the same technicians |
| 1–4 | Operate with **pricing Model B** (disclosed). Daily stand-ups. Weekly review |
| 5–8 | Operate with **pricing Model C** (disclosed). Optional third zone |
| 9 | Stabilise. Complete interviews. Warranty follow-ups |
| 10 (wrap) | Analysis, decision memo against exit criteria, data disposition (§13) |

Warranty windows extend beyond the pilot. Ops honours every warranty claim until it expires.

---

## 4. Team

| Role | FTE | Responsibilities |
|---|---|---|
| Pilot lead (city manager) | 1 | Owns KPIs, escalations, technician relations |
| Ops agents (booking, dispatch, diagnosis desk) | 3–4 | Morning–evening shifts, Telugu + English |
| Safety lead (on call during service hours) | 1 (+ backup) | SOS, incidents, complaints of conduct |
| Field agents | 2–3 | Technician onboarding, training, support visits |
| Data/analyst (part-time) | 0.5 | Daily data quality, metrics, failure log |
| Finance (part-time) | 0.3 | Weekly commission settlement, reconciliation |

---

## 5. Legal & compliance minimums before real customers ⚖️
1. Operating entity, bank account, CA engaged. GST registration and treatment advice for the interim model.
2. **Customer terms + privacy notice** (Telugu/English): service model, pricing, cancellation, warranty, complaints/grievance contact, data use and retention, consent capture (WhatsApp/verbal with a record).
3. **Technician agreement** (Telugu/English): independent status, commission, conduct, safety, data, BGV consent, dispute/appeal process.
4. BGV vendor contract + consent. Policy on police verification as advised for Andhra Pradesh ⚖️.
5. Accident cover for technicians via an insurer/partner if feasible (founder decision. Not built in-house).
6. Use WhatsApp Business (official) and normal calls. **No bulk SMS without DLT registration.**
7. Check Andhra Pradesh rules for platform/gig workers and establishments ⚖️.

---

## 6. Money handling (interim, pending D-08) ⚖️

To avoid acting on the unresolved PA/marketplace model, the pilot uses **direct pay to technician + commission remittance**:
- The customer pays the technician directly at completion: **cash or the technician's own UPI QR**, for the exact amount on the customer's quote/receipt message (sent by ops to the customer's WhatsApp/number).
- Ops confirms payment with the customer by a WhatsApp reply or call (mirrors the cash-confirmation step).
- Technicians remit the platform's commission/fees **weekly by UPI** to the company account, against a statement ops sends them (mirrors the ledger statement: gross, commission, net, cash commission due).
- Diagnosis payouts for technicians who did diagnosis-only or different-technician visits are **paid by the company weekly** (UPI/bank) when the customer paid the repairing technician.
- **The platform never holds customer money** in this interim. A ledger-shaped spreadsheet (double entry by job) tracks every amount so pilot data maps into the future ledger.
- ⚖️ CA to confirm invoicing/receipts and GST in this interim model before launch. If counsel approves platform collection earlier, switch to PA payment links for online payments.

Trade-off: this doesn't test platform-collected online payments, and it increases commission-collection risk (which is itself measured: H4/H5).

---

## 7. Data handling SOP (resolves SR-19)
- **Company-owned** phones and WhatsApp Business accounts only. No personal phones for customer data.
- A single **access-controlled workspace** (company tenant, MFA, no external sharing, India data location where possible). The job sheet holds: job ref, locality, category, timestamps, amounts and status. **Exact addresses and phone numbers sit in a separate restricted tab/table** visible to ops agents only.
- Technicians receive addresses **only by voice call from ops** (the pilot equivalent of IVR playback, D-01), only within the disclosure window. **Never by SMS/WhatsApp text.** Customer numbers are **not** shared. Ops bridges calls (conference) or uses the telephony provider's masking product if available.
- Weekly access review. Exports disabled. A pilot privacy notice is given to every customer and technician.
- **End of pilot:** customer PII deleted within 30 days unless the customer consented to migrate to the platform (warranty continuity). Pseudonymous job data kept for analysis. Disposition logged.

---

## 8. Daily operating process

| Time | Activity | Product step mirrored |
|---|---|---|
| 07:00–08:30 | **Technician check-in**: technicians send a missed call/WhatsApp "available + area". Ops updates the availability sheet | Daily check-in (H6 filter) |
| All day | **Booking intake** by phone/WhatsApp. Agent captures the symptom (chips list), locality + landmark, time window, payment preference. Sends the customer a booking confirmation with the job ref and the inspection-fee notice | Booking + idempotent job ref |
| Within 10 min | **Assignment** by the dispatcher using the written rules: hard filters (skill, zone, availability, verification, restrictions) → rotation sheet (fairness) → offer by call/WhatsApp to **one technician at a time** with a 5-min window (basic phone: 10 min) | Matching + exclusive offers |
| On accept | Ops sends the technician job ref + locality + time (text). **Address by voice call** within the window. The customer gets the technician's photo/first name + **4-digit door code** | L0/L1/L2 disclosure + start code |
| On arrival | The technician calls ops/sends the code. Ops verifies the code | Presence proof |
| Diagnosis | App-capable technicians fill a **WhatsApp diagnosis template** (structured) + photos. Basic-phone technicians call the **diagnosis desk** (ops fills the template from the repair catalog). Ops prices it from the reference sheet | Diagnosis + server-side pricing |
| Quote | Ops sends the itemised quote to the **customer's own WhatsApp/number**. The customer replies "YES {job ref}" / "NO" (or approves on an ops call to their registered number, logged) | Hash-bound approval (quote version number in the message) |
| Repair | Same visit if eligible, else a repair visit scheduled with the same technician or a specialist (customer's choice). Material checklist confirmed by call before departure | Repair order + repair visit |
| Changes | Any price change → a **new quote version** sent to the customer. No work on new items before "YES" | Immutable versions |
| Completion | **Completion code** from the customer → technician → ops. Final amount sent to the customer. Payment per §6. Customer confirms | Completion code + bill + cash confirmation |
| Same day | Warranty message (coverage, days, how to claim) + rating request (1–5 + tags) for each technician | Coverage + per-technician ratings |
| 19:30–20:30 | **Daily close:** reconcile jobs vs. payments, unresolved issues, failure log entries, the next day's scheduled visits confirmed | Reconciliation |
| Weekly (Mon) | Technician statements, commission settlement, payout of diagnosis/compensation amounts, pilot review meeting | Payouts |

**SOS in the pilot:** a published safety phone number (ring group: safety lead + backup + pilot lead) during service hours. Customers and technicians are told "In danger, call 112 first." No numeric response promise beyond what is staffed.

---

## 9. Customer acquisition
- WhatsApp community/colony groups and resident welfare associations in the pilot zones (with admin permission), with a Telugu/English poster + booking number + QR.
- Pamphlets/stickers at local hardware/electrical shops, medical stores and kirana stores in the zones (shopkeepers often also refer technicians).
- Google Business Profile listing for the pilot service area.
- Door-to-door introductions by field agents in 1–2 apartment complexes per zone.
- Word of mouth. **No paid referral incentives** (fraud magnet). A small first-booking discount only if the founder approves, and tracked as a cost.
- Measure: source per booking (captured at intake).

## 10. Technician acquisition
- Hardware, electrical and appliance spare-parts shops, plus RO/water-purifier and appliance dealers' local service networks (owners know local technicians). Shop owners can act as field agents (with conflict-of-interest rules).
- ITI and skill-training centre alumni (electrician, plumber, refrigeration & air-conditioning and appliance-repair trades). PMKVY-type programme alumni.
- Existing technician networks/associations and word of mouth.
- **Onboarding:** interview + trade test by a senior technician, ID verification (DigiLocker or vendor), **BGV initiated and cleared before any solo home visit** (founder Q11: recommended minimum for the pilot), training session (product logic, codes, pricing, safety, conduct, IVR/calls), agreement signed, PIN set (if the IVR is used).
- Target mix: ≥ 30% basic-phone. Include women technicians where available, with a safety briefing designed with them.

---

## 11. Metrics (tracked daily, reviewed weekly)

| Area | Metrics |
|---|---|
| Funnel | Enquiries → bookings → diagnosis visits done → quotes → approvals → repair visits → completed → paid → rated (**all broken down by category and service type**, plus unmet requests for non-enabled service types) |
| Speed | Time to assign (ASAP/scheduled). Time to arrival vs. window. Approval → repair visit lead time |
| Quality | Rework/warranty claims. Complaint rate (raised/upheld). Rating distribution per technician. Customer satisfaction (1–5) |
| Price | Quote amounts by repair item. Deviation from reference. Rejection reasons. Disputes about price |
| Technicians | Active days. Offers received (rotation fairness). Acceptance. **Earnings per active day**. Commission collection. Retention week over week. Basic vs. smartphone parity |
| Ops cost | Agent minutes per booking, per diagnosis (desk), per dispute. Calls/messages per job |
| Economics | Measured inputs for every [06](06-pricing-and-unit-economics.md) variable. CM per job by scenario and pricing block (**Model B and Model C only. Model A isn't approved**). Track actual: diagnosis payout, repair payout, telephony cost, support time, material handling, cancellation cost, warranty cost, payment costs, and tax impact once legally confirmed |
| Safety/trust | SOS calls. Incidents. Door-code use rate. Identity mismatches. Address-disclosure deviations |
| Reliability | Technician no-shows. Customer cancellations after travel. Waiting events |
| Data quality | % of jobs with complete records (all steps timestamped, amounts, evidence) |

---

## 12. Failure logging
Every deviation is logged the same day in a **failure log** with: date, job ref, step (booking/assignment/visit/diagnosis/quote/approval/repair/payment/warranty/rating/safety/data), category (people/process/tech/communication/pricing/supply/customer behaviour), what happened, impact (customer/technician/money/safety), root cause (5 whys for severity ≥ medium), fix, owner, and whether it implies a **product requirement change** (tagged for the Phase 2 backlog).
Severity: S1 safety/money loss, S2 customer harmed/job failed, S3 delay/friction, S4 cosmetic.

---

## 13. Interview questions

**Fields recorded for every customer interview** (structured, alongside the free-text answers): preferred language (Telugu / English / Other-not specified; optional, purpose-limited per Q-C), service category, exact service type, whether the customer understood diagnosis-first pricing (yes / partly / no), trust concerns (coded list + note), booking friction points (coded list + note), and willingness to reuse (yes / maybe / no).

**Customers** (after the job; ~20 interviews spread across outcomes, including rejections and complaints)
1. How did you hear about us? Why did you choose us over calling a local technician?
2. Was the inspection/visit fee clear before booking? Was it fair?
3. Did you understand the quote? What made you approve or reject it?
4. If the repair needed a second visit: how did that feel? Would you have preferred waiting for the same technician or a specialist sooner?
5. Did you feel safe? What made you feel safe or unsafe (photo, door code, verification)?
6. Did you use the door/completion codes? Was anything confusing?
7. How did you pay? Would you pay online next time? Why/why not?
8. Was anything charged that you didn't expect?
9. Would you book again? Would you ask for the same technician?
10. Who in your family usually arranges repairs? Which language do you prefer for calls/messages? (Record the language preference: Q-C.)

**Technicians** (weekly short check-in + ~20 longer interviews)
1. How many jobs did you get vs. expected? Did offers feel fairly distributed?
2. Were the earnings shown before accepting accurate? Was the commission clear?
3. How was getting the address and contacting the customer?
4. Diagnosis: was the repair catalog/price list realistic for Kurnool? What's missing?
5. Second visits / specialist hand-offs: fair to you? Did you lose customers or gain them?
6. Cash vs. online: what do customers prefer? Is remitting commission weekly a problem?
7. Did you ever feel unsafe or disrespected? What should we change?
8. What would make you leave the platform? Would you take customers off-platform? Why?
9. For basic-phone users: how were the calls/agent help? What was hard?
10. Compared with your current work: better, same or worse? Why?

---

## 14. Exit criteria (decision at week 10)

| Outcome | Criteria (all illustrative thresholds, to be confirmed by the founder before the pilot starts) |
|---|---|
| **Proceed to implementation as designed** | ≥ 250 completed jobs. Quote approval ≥ 55%. Approved-repair completion ≥ 80% (drop-off between approval and repair ≤ 20%). Median time to assign (ASAP) ≤ 45 min. Technician no-show ≤ 5%. Customer satisfaction ≥ 4.2/5. **Zero unresolved S1 safety incidents.** Upheld price disputes ≤ 3% of jobs. Basic-phone technicians' completion parity ≥ 0.85 of smartphone technicians. Desk time ≤ 8 min per basic-phone diagnosis (or a credible V1.1 plan). Measured CM ≥ 0 per repaired job for at least one pricing model (excluding tax uncertainty, flagged separately). Technician earnings per active day ≥ their stated baseline for ≥ 60% of active technicians. Data completeness ≥ 90% |
| **Proceed with adjustments** | Most criteria met, but specific gaps (e.g., approval 45–55%, desk time 8–12 min, two-visit drop-off 20–30%) → named design changes before Phase 2 (e.g., more same-visit eligibility, pricing tweaks, catalog changes) |
| **Pause / rethink** | Any of: unresolved S1 safety incident pattern, approval < 40%, two-visit drop-off > 35%, CM negative for every pricing model with measured costs, basic-phone parity < 0.6 after fixes, technician retention < 50% by week 6 |

The pilot outcome feeds: which appliance service types to keep, enable or disable (H9; a config change), final pricing model (D-07), IVR design, repair catalog/reference prices, locality data, ops staffing model, and the Phase 2 backlog.
