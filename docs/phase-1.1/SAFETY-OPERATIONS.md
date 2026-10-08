# Safety Operations Specification (pilot + V1)

> **Status:** APPROVED direction (2026-10-08). **Not active until staffed.** Hours and names are filled in when the founder confirms staffing (Q13).
> **Language rule:** no "24/7 safety support" or numeric response-time promise appears in any customer/technician-facing copy unless it is operationally true and tested. The emergency number guidance (**112**) is always shown first.

---

## 1. Safety desk hours
| Item | Definition |
|---|---|
| Service hours (visits can happen) | Pilot: **08:00–20:00 IST**, 7 days (config per city). No visits are scheduled outside these hours |
| Safety desk staffed hours | **Service hours + 30 min on each side (07:30–20:30)**, so every visit in progress has cover. Minimum 1 on-duty safety officer + 1 backup on call. **Not live until named staff are rostered** |
| Outside staffed hours | No active visits by design. The SOS line plays: "If you are in danger, call 112 now." and connects to the **on-call safety lead's phone** only if an on-call rota exists. Otherwise it records a callback request for 07:30. Copy is truthful about this |
| Public statement | "Safety team available during service hours (8 AM–8 PM). In an emergency, always call 112." |

## 2. Escalation tree
```
SOS raised (PWA / app / IVR / missed call / support line)
  └─▶ L1 On-duty safety officer (ring group, 2 phones)       answer target set after staffing; measured, not promised
        └─ no answer in 60 s ─▶ L2 Backup safety officer
              └─ no answer in 60 s ─▶ L3 Safety lead (mobile)
                    └─ no answer in 2 min ─▶ L4 City manager + founder on-call
At any level: immediate danger → guide caller to 112 / ops calls 112 on their behalf with consent
Medical → 108 ambulance guidance · Fire → 101 · Women helpline 181 (per state availability) · Police 112
Post-incident: L3 informs legal counsel for P1 incidents (same day)
```
Every hop is logged with timestamps (incident timeline). Escalation runs from the **telephony provider's ring-group/sequential routing**, not from our application, so it keeps working when our backend is degraded.

## 3. Resilience: the safety path must keep working when…
| Failure | How SOS still works | Test (monthly drill) |
|---|---|---|
| **Admin IdP down** | Alerts reach safety staff by **phone ring group + SMS** with job ref, locality and a callback bridge number. Staff act by phone. The console isn't required. Incident details are recorded in the offline incident form (§7) and backfilled | Disable IdP access in staging. Raise SOS. Confirm phone + SMS alert and a completed callback |
| **Main dashboard unavailable** | Same as above. The SOS board is a convenience, not a dependency | Console down drill |
| **One telephony provider down** | The SOS number has **provider-side static routing** to the ring group. The secondary provider carries a second SOS number (printed on technician ID cards and in the app). The app/PWA shows `tel:` links to both + 112 | Primary provider simulated outage. Call both numbers |
| **One messaging provider down** | SMS alerts are sent via the second DLT SMS provider. WhatsApp alert as a tertiary channel | Primary SMS outage simulation |
| **Our backend down** | The provider's static routing still connects SOS calls to the ring group. App/PWA SOS screens work offline (`tel:` links). The incident is logged manually and backfilled | Backend-down drill (staging) |
| **Mobile network outage at the customer's location** | Not solvable by us. Guidance: 112 from any available phone. Technician training includes leaving and calling from a safe place | Training only |

## 4. Technician safety
- **Right to refuse or leave** any unsafe situation without penalty (assignment release reason `SAFETY_CONCERN` never counts in metrics). Payout for the visit is protected pending review.
- **Pre-accept signals:** the customer is phone-verified, completed-jobs count (bucketed), and a no-safety-flag indicator (no details).
- **Technician restrictions** (hard filter H12): no late slots, avoid zones, avoid a specific customer (block).
- **Discreet SOS:** app long-press, IVR option 8 / dedicated SOS number, missed call → callback. The safety desk can call the technician with a neutral script ("Your order is confirmed") so the technician can answer yes/no questions safely.
- **Women technicians:** safety briefing co-designed with them, optional photo hiding, preferred zones/time windows, a check-in call option for first visits to new customers.
- **After an incident:** customer blocked from booking that technician, a welfare follow-up call, support for police complaints if the technician wishes (never forced).

## 5. Customer safety
- Verified technician card before arrival (photo, first name, badges). "Is this the person at your door?" check. Mismatch → P1 flow and the technician is asked to wait outside.
- Door code shared only at the door. Completion code only when satisfied (SR-13).
- Masked calls only. Bindings expire after the visit window.
- Discreet reporting for harassment (no technician notification until the safety review decides).
- Share-status-with-family (V1.1).

## 6. Adult-present policy
- At booking the customer states who will be home: **Self / Adult family member / Other adult** (`jobs.onsite_adult`), with an optional on-site adult contact when booking for someone else.
- **An adult (18+) must be present for the whole visit.** If only minors are present, the technician doesn't enter, calls ops from outside, and may leave **without penalty**. The visit is rescheduled, with no-show rules applied only if the customer was warned and unreachable.
- The technician app/IVR reminds them at arrival ("Is an adult present? 1 yes, 2 no").
- Applies to every category and service type.

## 7. Incident documentation
| Field | Notes |
|---|---|
| Incident ID, severity (P1–P3), channel, raised-by role | Auto from SOS / manual |
| Job/visit references, parties (IDs only in general logs) | Restricted record holds names/contacts |
| Timeline | Each escalation hop, call attempt, action, external contact (112/police ref, encrypted) |
| Location snapshot | Only if shared with consent, encrypted |
| Actions taken | Holds, blocks, interim suspension (≤ 72 h, safety officer), welfare follow-up |
| Evidence | Call metadata, messages, photos, statements (both sides heard) |
| Outcome & review | Decision, appeal path, lessons learned (blameless), product changes |
| Access | Safety roles only. Every read audited. Retention per ⚖️ (proposed 8 years) |
| Offline form | A paper/phone-note template used during IdP/console outages and backfilled within 24 h (backfill is itself audited) |

## 8. Readiness checklist (before any pilot visit)
- [ ] Named safety officers + backup rostered for all service hours
- [ ] Ring group + sequential escalation configured at **both** telephony providers. Static fallback tested
- [ ] SMS alerts via two providers tested
- [ ] SOS copy reviewed: no unstaffed promises, 112 first, Telugu + English
- [ ] Monthly drill schedule agreed (IdP down, console down, provider down)
- [ ] Technician safety briefing delivered (incl. adult-present policy)
- [ ] Legal counsel contact for P1 incidents
