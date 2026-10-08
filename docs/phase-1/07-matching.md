# Phase 1 · 07 — Technician Matching Engine

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Matching operates **per visit**, not per job. A diagnosis visit and its repair visit are matched independently, with different required skills.

---

## 1. Goals and non-goals

**Goals, in priority order:** (1) safety and eligibility, (2) the customer gets someone qualified who shows up, (3) **fair opportunity for technicians, including basic-phone technicians**, (4) efficiency (travel, time-to-assign), (5) every decision is explainable and logged.

**Non-goals for V1:** ML ranking, dynamic pricing, batch-optimal global assignment (Hungarian/min-cost flow), continuous location tracking.

---

## 2. Triggers

| Trigger | Source | Notes |
|---|---|---|
| `VisitReadyForMatching` | jobs (timer `match_start`) | ASAP → immediately. Scheduled → `window_start − lead` (config per city/urgency, e.g., 18 h for next-day slots, so basic-phone technicians are offered in their preferred call window). |
| Assignment released / technician no-show | jobs | Re-match with `urgency_boost`. The previous technician is excluded for this visit. |
| `CheckinRecorded` / `PresenceChanged(online)` | workforce | Re-run for UNFULFILLED or MATCHING visits in that locality (debounced 60 s). |
| Repair order scheduled | jobs | `SAME_TECHNICIAN` → **direct offer** first (§6.4). |
| Ops manual | admin | Run with an optional widened radius / relaxed soft constraints (hard filters never relaxed). |

---

## 3. Stage 1: candidate pool (cheap, indexed)

Union of technicians where:
- an active skill for `visit.required_service_type_id` (+ specialization if set) exists, with `can_diagnose` / `can_repair` matching `visit.required_capability`; **and**
- a service area covers the visit locality: `locality_id = visit.locality_id`, **or** in the adjacency set within `max_hops` (config, default 1), **or** (smartphone + consented recent location share) within the technician's `max_radius_km`.

Pool size is capped (e.g., 200) by proximity tier before filtering.

**Skill specificity (catalog revision, ADR-020):** matching only ever receives `service_type_id`, the required capability (`DIAGNOSE`/`REPAIR`), an optional specialization, the service area and availability. There is **no generic "appliance technician" skill**. A technician holding REFRIGERATOR skills isn't eligible for an RO or washing-machine visit unless they hold those service-type skills. A refrigerator repair needing `GAS_REFRIGERATION` requires that specialization at level ≥ ASSESSED. Adding appliance service types adds catalog rows and technician skills, not matching logic.

---

## 4. Stage 2: hard filters (eligibility)

Every filter has an **exclusion reason code** stored in `match_candidates.exclusion_reasons`.

| # | Filter | Rule | Source | Reason code |
|---|---|---|---|---|
| H1 | Skill | Active skill for required service type/specialization and capability | workforce | `NO_SKILL` |
| H2 | Specialization | If the visit needs a specialization (e.g., AC inverter PCB), level ≥ ASSESSED | workforce | `NO_SPECIALIZATION` |
| H3 | City | Technician city = visit city | workforce | `OTHER_CITY` |
| H4 | Zone / service area | As in §3 | workforce/geo | `OUT_OF_AREA` |
| H5 | Availability (weekly) | The visit window overlaps the weekly availability minus UNAVAILABLE overrides, plus EXTRA overrides | workforce | `NOT_SCHEDULED` |
| H6 | Today's presence | **Smartphone:** `online=true` (ASAP) or schedule-based (scheduled visits). **Basic phone:** a check-in for the service date with `available=true` and a locality within reach, **or** the technician's policy is `SCHEDULE_BASED` (config per technician, set with the agent) | workforce | `NOT_CHECKED_IN` / `OFFLINE` |
| H7 | Working hours | The visit window is within the technician's working hours **and** the platform's quiet-hours policy (no IVR calls 9 PM–7 AM unless the technician opted in) | config | `OUTSIDE_HOURS` |
| H8 | Verification level | ≥ `service_rules.min_verification_level`, and the required check is not expired | verification | `VERIFICATION_LEVEL` |
| H9 | Status | `ACTIVE` or `PROBATION` (probation limited by a daily cap) | workforce | `STATUS` |
| H10 | Capacity | Overlapping ACTIVE assignments < capacity. **No other PENDING offer whose window overlaps this visit** (ASAP: one at a time. Non-overlapping scheduled/direct offers may coexist: G-3) | jobs/matching | `AT_CAPACITY` / `HAS_PENDING_OFFER` |
| H11 | Customer safety restrictions | Not blocked by/blocking the customer. No open safety sanction. Not under an investigation hold. Not the subject of an upheld conduct complaint by this customer | trust | `CUSTOMER_RESTRICTION` |
| H12 | Technician safety restrictions | The technician hasn't flagged this customer/address `UNSAFE`. The customer isn't under a safety hold. The technician's own exclusions (e.g., no night visits) | trust/workforce | `TECH_RESTRICTION` |
| H13 | Language (only if required) | If the customer marked "must speak X", the technician speaks X | customers | `LANGUAGE_REQUIRED` |
| H14 | Explicit opt-in requirement (future) | Only if `service_rules.worker_attribute_requirement` is set **and** the customer explicitly requested it. **Disabled in V1** | catalog | `ATTRIBUTE_REQUIREMENT` |
| H15 | Previously excluded for this visit | Released / no-show / declined earlier in this visit's matching | matching | `ALREADY_TRIED` |
| H16 | Conflict of interest | Warranty inspection alleging poor workmanship → exclude the original technician (config) | warranty | `CONFLICT_OF_INTEREST` |
| H17 | Device reachability | Basic-phone technician: IVR available (telephony circuit closed). App technician: push token present or IVR fallback configured | voice/comms | `UNREACHABLE_CHANNEL` |
| H18 | Cash cap (D-13) | If the customer's `payment_preference = CASH`, exclude technicians whose cash status is `CAPPED`. `ONLINE`/`EITHER` visits stay eligible | payments/workforce | `CASH_CAPPED` |

Hard filters **are never relaxed** automatically. Ops may widen only *area* (H4: hops/radius) for a specific run, with a logged reason.

---

## 5. Stage 3: soft scoring

`score = Σ wᵢ·fᵢ + jitter`, with each `fᵢ ∈ [0,1]`. Weights come from the active `matching_configs` version (per city, maker-checker). **Defaults below are starting points to be tuned on concierge-pilot data.**

| Feature | Definition | Default w |
|---|---|---|
| **f_travel**: estimated travel time | `est_min` from the **best available location signal, all snapped to localities**: (1) consented share-once point < 30 min old → snapped to nearest locality; (2) today's check-in locality; (3) current/last visit's locality if finishing nearby before the window; (4) primary locality; (5) secondary locality. Then the locality-graph travel time (`locality_adjacency.travel_minutes_typical`, shortest path), optionally adjusted by a routing API for the top 10. `f = clamp(1 − (est_min − 10)/(max_min − 10), 0, 1)`. **GPS precision gives no advantage:** GPS only picks a locality. | 0.25 |
| **f_reliability** | Beta-smoothed share of commitments honoured (90 d): `(kept + α)/(commitments + α + β)` where failures = upheld no-shows + unforgiven late releases. Prior α=8, β=1 (new technicians start high but not perfect). | 0.20 |
| **f_on_time** | Beta-smoothed share of arrivals within the window (start-code time vs window end + grace) | 0.10 |
| **f_rating** | `(bayes_rating − 1)/4`, Bayesian with zone prior m and C = 10 | 0.10 |
| **f_acceptance** | Acceptance rate of offers **actually delivered** (UNREACHABLE excluded), **computed separately per channel**, smoothed. Low weight, since declining is a right. | 0.05 |
| **f_workload** | `1 − active_or_upcoming_assignments_today / daily_soft_cap` | 0.10 |
| **f_fairness** | Opportunity deficit (§7): `σ(k · deficit_7d)` where deficit = expected opportunity share − actual offers share in the zone | 0.15 |
| **f_specialization** | 1 if exact specialization/certified, 0.6 assessed, 0.3 claimed | 0.05 |
| **jitter** | Uniform ±0.02, seeded by `match_run_id` (reproducible) | — |

**Customer preference** is not a score term in V1. "Same technician" uses a **direct offer** (§6.4), and the customer-required language is a hard filter (H13). Preferred-language match (not required) adds +0.02 as a tie-breaker.

**Never used:** gender, religion, caste, age, device price/model, phone speed, technician's earnings history as a *positive* signal (would compound inequality), customer's spending.

**Quality floor:** scoring doesn't exclude anyone. Technicians with serious quality issues are handled through the **sanction process** (coaching → probation cap → suspension with review), so no hidden algorithmic "shadow-ban" exists.

---

## 6. Stage 4: dispatch (offers)

### 6.1 Exclusive offers (the default)
- The top-ranked candidate receives an **exclusive** offer. Nobody else can take this visit during its window. **Speed of phone or network doesn't matter**, because there's no race.
- **Offer windows by channel** (config):

| Channel | Window | Attempts |
|---|---|---|
| App push (high-priority FCM, full-screen intent) | 90 s | If not delivered/seen in 45 s → IVR call to the same technician (if `PUSH_THEN_IVR`) |
| IVR call | Until call outcome + ≤ 2 attempts 60 s apart (≈ 4 min). **While an offer call is in progress the offer is held** (`held_until` = call end + 30 s, hard cap 6 min), so DTMF acceptance can't expire mid-call (G-2) | Unreachable → next candidate (no penalty) |
| Scheduled visits (lead ≥ 6 h) | Up to 30 min for either channel. IVR calls only within the technician's preferred call window | — |

- A technician has at most one pending offer **per overlapping window** (H10, G-3). Accept-time re-validation (INV-02/03) prevents conflicts.

### 6.2 Cascade
`rank 1 → (expire/decline/unreachable) → rank 2 → …` until accepted, the pool is exhausted, or the **SLA budget** (e.g., ASAP: 20 min to assign) is consumed. Each step is a durable timer.

### 6.3 Waves (only under SLA pressure)
When the remaining SLA budget < `wave_threshold`, the next K candidates (K = 2–3) receive a **wave offer**:
- All wave recipients see "Interested? Tap/press 1 within N minutes."
- Acceptances are **collected for the whole wave window**, not first-come-first-served. At window close, the **highest-ranked acceptor** is assigned (TCP-1). Others hear "Assigned to another technician. Thank you, you get priority next time," and get a fairness credit.
- This preserves **IVR/app parity** even in waves: a basic-phone technician who presses 1 in minute 3 can win over an app technician who tapped in second 2.
- The window is long enough for an IVR call cycle (≥ 3 min).

### 6.4 Direct offers (repair continuity)
For a repair order with `SAME_TECHNICIAN`: one exclusive offer to the preferred technician (they must pass all hard filters at that time) with a longer window (config, e.g., 2 h for scheduled). On decline/expiry: if `allow_fallback` → normal cascade (and the customer is notified of the change); else → customer is asked to choose (notify + approval link).

### 6.5 Exhaustion
Pool exhausted or SLA exceeded → `MatchExhausted` → visit `UNFULFILLED` → ops board + the customer is offered alternatives (next slots, callback). New check-ins in the area re-trigger matching (debounced).

---

## 7. Fairness: definition and mechanisms

**Definition (V1):** *Technicians with similar eligibility should receive a similar share of offers, relative to how much they made themselves available, regardless of device type.* We measure **opportunity** (offers received) rather than outcomes (earnings), because outcomes also depend on technician choices.

- **Eligible minutes:** per technician per day per zone, the minutes they were eligible (available + checked-in/online + not at capacity). Tracked in `matching.fairness_ledger`.
- **Expected share** = technician's eligible minutes / Σ eligible minutes of the zone's peers with the same skill.
- **Actual share** = offers received / Σ offers in that peer group (rolling 7 days).
- **Deficit** = expected − actual. Positive deficit raises `f_fairness`. Technicians who were passed over get priority next time.

**Mechanisms that protect basic-phone technicians specifically:**
1. Exclusive offers (no race).
2. Longer, channel-appropriate offer windows. Response *time* is never scored.
3. UNREACHABLE (network) ≠ decline. Acceptance propensity is computed per channel.
4. Scheduled jobs are offered in the technician's preferred call window.
5. The location signal comes from check-ins and service areas, with no GPS bonus (all signals snapped to localities).
6. Waves use rank-ordered acceptance, not first-tap.
7. **Parity monitor** (daily, per zone): `parity = (offer share of basic-phone techs) / (eligible-minute share of basic-phone techs)`. Alert if < 0.85 for 3 consecutive days, with automatic diagnostic breakdown (which filter/feature drives the gap).
8. Same for **new vs. tenured** technicians (cold-start boost via priors, and the fairness term handles the rest).

**Guardrails so fairness doesn't harm customers:** fairness can reorder candidates whose base score (without fairness) is within `fairness_band` (e.g., 0.15) of the top candidate. It never promotes someone far less suitable.

**Reporting:** monthly fairness report per city: Gini coefficient of offers/eligible-minute, parity ratios by device mode, tenure and zone. Reviewed by the city manager.

---

## 8. Explainability & logging

For every match run (`matching.match_runs`, `matching.match_candidates`, `matching.offers`):
- config version, trigger, visit snapshot (required skill, locality, window, urgency)
- pool size, every candidate's **eligibility + exclusion reasons**
- for eligible candidates: every feature value, weights, jitter seed, final score, rank
- offer sequence with channel, timings, delivery attempts, outcomes
- the final assignment (or exhaustion reason)

**Who can see what:**
- **Ops/dispatch:** the full breakdown for a visit ("Why did Imran get this and not Ramesh?").
- **Technician** (app screen / IVR / agent): *own* data only, e.g., "This week: available 32 h, received 11 offers, accepted 8. Ways to get more jobs: check in daily, add Civil Lines as a secondary area." **Never** other technicians' data or scores.
- **Auditor:** aggregated fairness reports. Spot checks.

Retention: candidates 180 days, then aggregated. Offers and runs for job retention.

---

## 9. Configuration, safety of changes, simulation

- `matching_configs.params` (JSON-schema validated): weights, priors, windows, wave threshold, fairness band, SLA budgets, hops, caps, quiet hours.
- Changes: draft → **offline simulation** (replay the last 30 days of visits with the candidate states at the time; compare fill rate, travel, parity, fairness) → maker-checker approval → activation (per city). Every run records the config version.
- Kill switch: revert to the previous active version instantly.

**Metrics** (per city/zone, by device mode): fill rate, time-to-assign p50/p90, offers per assignment, unreachable rate, acceptance rate, parity ratio, Gini, travel-time estimate error (estimate vs actual departure→arrival), repeat-technician rate on repairs.

---

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| Matching worker crash mid-cascade | State is in `offers` + timers. The sweeper resumes within ~1 min. |
| Telephony down | H17 excludes IVR-only technicians → **parity drop is expected and alerted**. Ops dispatches manually by phone for basic-phone technicians if the outage exceeds 15 min. |
| FCM down | App technicians fall back to IVR (`PUSH_THEN_IVR`). |
| Stale candidate data (technician went offline after scoring) | `jobs.assignVisit` re-validates INV-02/03 at accept time → `NOT_ELIGIBLE` → next candidate. |
| Two visits want the same technician | One pending offer per technician (H10). The second visit's matching skips them until resolved. |
| Thundering herd (many visits at 9 AM) | Matching jobs are queued with per-city concurrency. ASAP visits are prioritised over scheduled ones. |
