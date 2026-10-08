# Phase 1.1 · 06 — Pricing Simulator & Unit Economics Model

> Status: **DRAFT for founder review** · Date: 2026-10-08
> **No pricing rule is final (D-07 PENDING).** All numbers below are **illustrative assumptions**, not market data. They exist to expose structural problems (which scenarios lose money and why) before code is written. **Nothing here claims profitability.** Every input marked 🧪 must be replaced with pilot data.

---

## 1. Model structure

### 1.1 Inputs (configurable)

| Variable | Symbol | Baseline (illustrative) | Source needed |
|---|---|---|---|
| Diagnosis / visit fee | D | model-dependent (₹99–149) | 🧪 pilot acceptance |
| Visit-fee credit on approval | c | model-dependent (0–100%) | founder decision |
| Typical repair labour | L | ₹400 | 🧪 pilot (varies widely by category) |
| Material (at cost) | M | ₹250 | 🧪 pilot |
| Material markup | mk | 0% | founder/legal |
| Platform fee on repaired jobs | pf | model-dependent (₹0–29) | founder |
| Technician share of labour | s | 80% | founder (commission = 1 − s) |
| Technician diagnosis payout (different technician) | Pd | ₹100 (A, C) / ₹70 (B) | founder |
| Diagnosis payout share when the same technician repairs (D-06 PARTIAL) | p | 50% | founder |
| Share of bills paid online | on | 50% | 🧪 |
| Payment-provider fee on online amount | pa | 2% | PA contract 🧪 (UPI pricing varies by PA/plan) |
| Telephony per visit, app technician | t_app | ₹2 | provider quote 🧪 |
| Telephony per visit, basic-phone technician | t_basic | ₹6 | provider quote + field test 🧪 |
| Share of basic-phone technicians | bp | 40% | 🧪 |
| SMS/WhatsApp per visit | msg | ₹1.5 | provider quote 🧪 |
| General support cost per job | sup | ₹12 | 🧪 ops timing |
| Ops diagnosis desk per basic-phone diagnosis | desk | ₹24 (≈6 agent-min) | 🧪 pilot |
| Cancellation fee / collection probability | F, q | ₹99 / 60% | founder + 🧪 |
| Technician travel compensation | Ct | ₹60 | founder |
| Technician no-show goodwill to customer | G | ₹50 | founder |
| Refund rate (% of bill) | r | 3% | 🧪 |
| Fraud loss (% of bill) | f | 1% | 🧪 |
| Warranty claim rate (repaired jobs) | w | 5% | 🧪 |
| Warranty revisit payout | Pw | ₹150 | founder |
| **Platform-borne tax placeholder** on (retained visit fee + labour) | τ | **0%** (sensitivity: 18% GST-inclusive) | **⚖️ CA** |

### 1.2 Formulas (per scenario)

```
CustomerPayment (repair)  = D·(1 − c) + L + M·(1 + mk) + pf
CustomerPayment (diag only) = D
TechDiagnosisPayout       = Pd (different technician) | Pd·p (same technician repairs) | Pd (diagnosis only)
TechRepairPayout          = s·L                       (+ waiting/cancellation compensation where applicable)
MaterialCost              = M                         (reimbursed to the technician at cost)
PlatformCommission        = CustomerPayment − TechDiagnosisPayout − TechRepairPayout − MaterialCost − Compensation
PaymentProviderCost       = CustomerPayment · on · pa
OtherVariableCost         = visits·(t_basic·bp + t_app·(1 − bp) + msg) + sup + desk·bp (if a diagnosis happened)
                            + CustomerPayment·(r + f)
ExpectedWarrantyCost      = w · (Pw + one visit's telephony/messaging + sup)       (repair scenarios only)
TaxPlaceholder            = τ · (D·(1 − c) + L)     (only if the platform bears tax on an inclusive price; ⚖️)
ContributionMargin (CM)   = PlatformCommission − PaymentProviderCost − OtherVariableCost − ExpectedWarrantyCost − TaxPlaceholder
```

Contribution margin excludes fixed costs (salaries of the core team, infrastructure baseline, marketing/CAC).

### 1.3 Three candidate pricing models (for testing, not final)

| | **Model A: full credit** (Phase 1 example) | **Model B: fixed inspection fee** | **Model C: partial credit + platform fee** |
|---|---|---|---|
| Visit fee D | ₹149 | ₹99 | ₹149 |
| Credit on approval c | 100% | 0% | 50% |
| Platform fee pf (repair jobs) | ₹0 | ₹0 | ₹29 |
| Diagnosis payout Pd | ₹100 | ₹70 | ₹100 |
| Same-tech diagnosis payout | 50% (PARTIAL) | 50% | 50% |
| Technician labour share | 80% | 80% | 80% |

---

### 1.4 Run per service type (catalog revision, ADR-020)
The baseline uses one generic "typical repair" (L = ₹400, M = ₹250). In practice labour, material, same-visit share, specialist hand-off share and warranty cost differ sharply between service types (e.g., an RO filter change vs. a refrigerator gas charge vs. a tap washer). The simulator must therefore be **parameterised per service type** (Plumbing, Electrical, Refrigerator, RO/Water Purifier, Washing Machine, Geyser, Air Cooler, and AC when enabled), with blended results weighted by the pilot's actual service-type mix. The results below are the generic baseline only.

## 2. Scenario results (baseline assumptions, per scenario occurrence, ₹)

"Other var." = telephony + messaging + support + diagnosis desk + refunds + fraud. **⛔ = negative contribution margin.**

### Model A: full credit
| Scenario | Customer pays | Diag payout | Repair payout | Material | Platform commission | PA cost | Comp. | Tax | Other var. | Exp. warranty | **CM** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 Same technician, same visit | 650.0 | 50.0 | 320.0 | 250.0 | 30.0 | 6.5 | 0 | 0 | 52.7 | 8.4 | **−37.6 ⛔** |
| S2 Same technician, later repair | 650.0 | 50.0 | 320.0 | 250.0 | 30.0 | 6.5 | 0 | 0 | 57.8 | 8.4 | **−42.7 ⛔** |
| S3 Different technicians | 650.0 | 100.0 | 320.0 | 250.0 | −20.0 | 6.5 | 0 | 0 | 57.8 | 8.4 | **−92.7 ⛔** |
| S4 Diagnosis only | 149.0 | 100.0 | 0 | 0 | 49.0 | 1.5 | 0 | 0 | 32.7 | — | **14.8** |
| S5 Customer cancels after travel | 59.4 (₹99 × 60% collected) | 0 | 0 | 0 | −0.6 | 0.6 | 60.0 | 0 | 19.5 | — | **−20.7 ⛔** |
| S6 Technician no-show (incremental) | −50.0 (goodwill) | 0 | 0 | 0 | −50.0 | −0.5 | 0 | 0 | 15.1 | — | **−64.6 ⛔** |
| S7 Warranty revisit (per claim) | 0 | 0 | 150.0 | 0 | −150.0 | 0 | 0 | 0 | 26.7 | — | **−176.7 ⛔** |

### Model B: fixed inspection fee
| Scenario | Customer pays | Diag payout | Repair payout | Material | Platform commission | PA cost | Comp. | Tax | Other var. | Exp. warranty | **CM** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 749.0 | 35.0 | 320.0 | 250.0 | 144.0 | 7.5 | 0 | 0 | 56.7 | 8.4 | **71.5** |
| S2 | 749.0 | 35.0 | 320.0 | 250.0 | 144.0 | 7.5 | 0 | 0 | 61.8 | 8.4 | **66.4** |
| S3 | 749.0 | 70.0 | 320.0 | 250.0 | 109.0 | 7.5 | 0 | 0 | 61.8 | 8.4 | **31.4** |
| S4 | 99.0 | 70.0 | 0 | 0 | 29.0 | 1.0 | 0 | 0 | 30.7 | — | **−2.7 ⛔** |
| S5 | 59.4 | 0 | 0 | 0 | −0.6 | 0.6 | 60.0 | 0 | 19.5 | — | **−20.7 ⛔** |
| S6 | −50.0 | 0 | 0 | 0 | −50.0 | −0.5 | 0 | 0 | 15.1 | — | **−64.6 ⛔** |
| S7 | 0 | 0 | 150.0 | 0 | −150.0 | 0 | 0 | 0 | 26.7 | — | **−176.7 ⛔** |

### Model C: partial credit + platform fee
| Scenario | Customer pays | Diag payout | Repair payout | Material | Platform commission | PA cost | Comp. | Tax | Other var. | Exp. warranty | **CM** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 753.5 | 50.0 | 320.0 | 250.0 | 133.5 | 7.5 | 0 | 0 | 56.8 | 8.4 | **60.8** |
| S2 | 753.5 | 50.0 | 320.0 | 250.0 | 133.5 | 7.5 | 0 | 0 | 61.9 | 8.4 | **55.7** |
| S3 | 753.5 | 100.0 | 320.0 | 250.0 | 83.5 | 7.5 | 0 | 0 | 61.9 | 8.4 | **5.7** (fragile) |
| S4 | 149.0 | 100.0 | 0 | 0 | 49.0 | 1.5 | 0 | 0 | 32.7 | — | **14.8** |
| S5 | 59.4 | 0 | 0 | 0 | −0.6 | 0.6 | 60.0 | 0 | 19.5 | — | **−20.7 ⛔** |
| S6 | −50.0 | 0 | 0 | 0 | −50.0 | −0.5 | 0 | 0 | 15.1 | — | **−64.6 ⛔** |
| S7 | 0 | 0 | 150.0 | 0 | −150.0 | 0 | 0 | 0 | 26.7 | — | **−176.7 ⛔** |

Notes: S5–S7 are pricing-model independent as configured. S7's expected cost is already included per repaired job in S1–S3 ("Exp. warranty" column), so it isn't added again in blended figures. It is shown separately because the per-claim loss is large.

### 2.1 Tax sensitivity: platform bears 18% GST on GST-inclusive prices (⚖️ illustrative only)

| Scenario | Model A | Model B | Model C |
|---|---|---|---|
| S1 | −98.6 ⛔ | −4.6 ⛔ | −11.6 ⛔ |
| S2 | −103.7 ⛔ | −9.7 ⛔ | −16.7 ⛔ |
| S3 | −153.7 ⛔ | −44.7 ⛔ | −66.7 ⛔ |
| S4 | −7.9 ⛔ | −17.8 ⛔ | −7.9 ⛔ |

**If the platform is liable for GST on the full service value (e.g., under the e-commerce-operator provisions for notified services) and prices are quoted tax-inclusive, every model is negative at these price points.** Tax treatment is therefore a **business-model blocker**, not an accounting detail.

---

## 3. Blended unit economics (baseline mix, illustrative)

**Mix assumptions 🧪:** quote approval 65%. Among repairs: same visit 50%, same technician later 20%, different technician 30%. Customer cancel-after-travel 8% of bookings. Technician no-show 3% of bookings. Technician handles 40 booked jobs/month. Customer books 1.5 jobs/year.

| Metric | Model A | Model B | Model C |
|---|---|---|---|
| CM per **booked job** (blended) | **−31.8 ⛔** | 30.5 | 27.0 |
| CM per **completed repair job** (S1–S3 weighted) | **−55.1 ⛔** | 58.4 | 43.2 |
| CM per **diagnosis-only** job | 14.8 | **−2.7 ⛔** | 14.8 |
| CM per **technician per month** (40 jobs) | **−1,271 ⛔** | 1,220 | 1,081 |
| CM per **customer per year** (1.5 jobs, before acquisition cost) | **−48 ⛔** | 46 | 41 |

### 3.1 Break-even conditions

| Condition | Model A | Model B | Model C |
|---|---|---|---|
| Labour L needed for S3 (different technicians) CM ≥ 0 | **≈ ₹1,020** | ≈ ₹200 | ≈ ₹370 |
| Labour L needed for S1 (same visit) CM ≥ 0 | ≈ ₹660 | ≤ ₹100 | ≤ ₹100 |
| Diagnosis-only CM ≥ 0 | met | D ≥ ≈ ₹102 (or Pd ≤ ≈ ₹67) | met |
| Booked jobs/month to cover an illustrative **₹3.35 lakh/month** pilot fixed cost (ops desk, safety cover, city manager, infra baseline) | never (negative CM) | ≈ 10,980 (~366/day) | ≈ 12,390 (~413/day) |

**Interpretation:** a 2–4-zone pilot won't cover fixed costs. That is expected, and the pilot's purpose is learning, not profit. The structural finding is that **a full visit-fee credit combined with a separately paid diagnosis technician is unsustainable at Tier-2 ticket sizes** unless typical labour is ≥ ~₹1,000.

### 3.2 Sensitivities (blended CM per booked job)

| Lever | Low | Base | High |
|---|---|---|---|
| Quote approval rate (45% / 65% / 85%) | B 19.3 · C 21.8 | B 30.5 · C 27.0 | B 41.7 · C 32.3 |
| Basic-phone technician share (20% / 40% / 70%), driving telephony + ops desk | B 36.0 · C 32.5 | B 30.5 · C 27.0 | B 22.3 · C 18.8 |
| Technician labour share (75% / 80% / 85%) | B 42.5 · C 39.0 | B 30.5 · C 27.0 | B 18.5 · C 15.1 |

Basic-phone inclusion costs money (ops desk + telephony). That is a deliberate product investment, and the model makes the cost visible. **Keypad repair codes (V1.1) are the main lever to reduce the desk cost.**

---

## 4. Recommended pricing models (for pilot testing) and trade-offs

| | Model B: fixed inspection fee | Model C: partial credit + platform fee | Model A′: full credit with a minimum repair charge |
|---|---|---|---|
| Customer message | "₹99 inspection. Repair price shown before any work." | "₹149 visit, ₹75 adjusted if you repair. Small service fee on repairs." | "Visit fee waived if you repair. Minimum repair charge ₹X." |
| Fairness to diagnosis technician | High (always paid; fee not credited) | High | High (platform funds the payout) |
| Customer perception | Clear, but "I pay the inspection fee even if I repair" | Moderately complex (two fees) | Most attractive. A minimum charge may feel unfair on tiny fixes |
| Margin robustness (S3) | Good | **Fragile** (+5.7) | Depends on minimum charge ≥ ~₹1,000 labour equivalent: **unlikely in Tier-2** |
| Diagnosis-only | Marginal (needs ~₹102+ or lower payout) | OK | OK |
| Complexity | Lowest | Medium | Medium |
| Main risk | Lower conversion to booking | Explaining two fees. Margin thin on specialist handoffs | Losses on specialist handoffs |

**Recommendation (not a decision):** test **Model B and Model C** in the manual pilot in **disclosed, time-sequenced blocks** (e.g., 3 weeks each, same zones, prices published upfront). Don't run simultaneous different prices for similar customers (fairness/consumer-protection concerns ⚖️). Choose based on booking conversion, approval rate, specialist hand-off share, complaint rate and measured costs. Model A is **not recommended** unless deliberately used as a time-boxed acquisition subsidy with a budget.

**Structural fixes regardless of model:**
1. Reduce S3 frequency where quality allows: dispatch `can_repair` technicians for diagnosis when the symptom strongly predicts the repair skill.
2. Warranty cost (S7) is the largest per-event loss. Track it per repair item and adjust warranty durations per item via config (data-driven, not punitive to technicians).
3. Cancellation economics (S5) are negative with 60% fee collection. Collection rate and the fee policy need pilot data.
4. Technician no-show (S6) costs ~₹65 per event. Reliability matters for economics too, but address it through the fair-review process, not automatic penalties.

---

## 5. Assumptions requiring real pilot data (priority order)
1. Typical labour and material per repair item and category in Kurnool (distribution, not averages).
2. Quote approval rate and reasons for rejection.
3. Same-visit vs. later vs. specialist hand-off shares by category.
4. Ops diagnosis-desk minutes per basic-phone diagnosis.
5. Telephony minutes per visit by flow (IVR field test + pilot).
6. Online vs. cash payment share. PA effective fees on our plan.
7. Cancellation-after-travel and no-show rates. Fee collection rate.
8. Warranty claim rate per repair item.
9. Refund and fraud losses.
10. Customer repeat rate (jobs/customer/year) and acquisition cost (outside CM).
11. **Tax treatment ⚖️ (single largest swing factor).**
12. Per-service-type distributions (labour, material, approval, specialist hand-off, warranty) for each enabled appliance service type (§1.4).

---

## 6. Simulator implementation note
The model above is specified so it can be implemented **as a spreadsheet** for founder use (inputs sheet, per-model scenario sheet, blended sheet, sensitivity sheet), and later as the **pricing simulator in the admin console** (Phase 1 `pricing` module), which must flag any rate card whose scenario CM is negative before maker-checker approval. Building the spreadsheet is a validation tool, not production code, and can be done on request. The numbers in this document were computed from the formulas in §1.2 with the baseline inputs in §1.1.
