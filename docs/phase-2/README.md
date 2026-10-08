# Phase 2: Foundation + Thin Vertical Slice (Plan)

> **Status:** DRAFT, awaiting founder approval · **Date:** 2026-10-08
> **No feature implementation code exists.** Coding starts only after the founder approves this plan.
> Inputs: Phase 0, Phase 1 (+ [FINAL-ERRATA](../phase-1.1/FINAL-ERRATA.md), which governs), Phase 1.1 (approved), [SAFETY-OPERATIONS](../phase-1.1/SAFETY-OPERATIONS.md), ADR-020 (catalog), ADR-021 (neutral identifiers).

## What Phase 2 builds
Only enough to complete **four production-shaped end-to-end scenarios** in `dev`/`test`/`staging`:
1. **Plumbing:** booking → diagnosis visit → quote → approval → separate repair visit → sandbox payment → receipt placeholder → warranty → rating.
2. **Electrical:** basic-phone technician via the **IVR simulator** + ops diagnosis desk + repair + cash confirmation.
3. **Appliance: "Refrigerator not cooling"**, with a specialist hand-off (proves the platform is category-based, not AC-specific).
4. **AC regression:** same-visit repair + price change (v2).

## Documents
| # | Document | Contents |
|---|---|---|
| 01 | [Implementation plan](01-implementation-plan.md) | Objective, non-goals, the 15 engineering rules and their enforcement, workstreams, sequence, DoD, AI and pricing limits, risks |
| 02 | [Repository structure](02-repository-structure.md) | Monorepo layout (`apps/`, `packages/`), module package layout, boundary rules B1–B12, config/secrets, CODEOWNERS |
| 03 | [Phase 2 gates](03-phase-2-gates.md) | Gates 1–12 with deliverables, exit criteria, errata applied, dependencies. **Spike S-1 (telephony authenticity)**, S-2 (device) |
| 04 | [UI information architecture](04-ui-information-architecture.md) | Design system (tokens, components, content), customer/technician/admin IA, Q-A quote UX, SOS screen, slice screen inventory |
| 05 | [First slice spec](05-first-slice-spec.md) | Fixtures, the four scenarios step by step with assertions, cross-cutting acceptance, out of scope |

## Hard constraints
- **SR-01:** production IVR state changes stay disabled until Spike S-1 passes (forged accept/arrive/complete/cash-confirm all rejected).
- **D-07:** no final pricing. Model A not approved. Models B and C are tested in the pilot.
- **D-08 / tax:** no live payment flow. Sandbox only. No tax lines.
- **Safety:** no SOS response-time promise and no "24/7" language until staffed. SOS must work with the IdP, dashboard, one telephony provider or one messaging provider down.
- No gate is skipped silently.

## Readiness

**Ready (can start on approval):** Gate 1 (repo, CI/CD, security scanning, dev/test IaC), Gate 2 (database foundation), Gate 4 (catalog/localization/geo), Spike S-1 and Spike S-2 setup, design-system and IA work, Telugu/English glossary drafting.

**Blocked:**
| Item | Blocked by |
|---|---|
| Real-provider IVR adapter, any production IVR state change | Spike S-1 |
| Gate 9 feature work (technician app) | Spike S-2 (ADR-004 decision) |
| Real-technician IVR use (pilot) | IVR field test R1/R2 thresholds |
| Gate 11 beyond sandbox (live money, payouts, invoices, tax lines) | D-08 + CA/legal answers (L-1…L-4) |
| Final pricing values | D-07 (pilot data, Models B vs C) |
| Recording features, ops-recorded approval enablement | D-15 (legal) |
| SOS copy with hours/response language | Safety staffing (SAFETY-OPERATIONS §8) |

**Founder actions:** approve this plan · confirm team + start date · AWS org/accounts + GitHub org · company IdP with passkeys · register `homesvcplatform.in` (ADR-021) · sandbox accounts (PA, ≥ 2 telephony providers, 2 SMS) under the vendor checklist (SR-23) · name a Telugu/English content owner + native reviewers · roster the safety desk for pilot hours · approve the two added apps (`admin-web`, `media-scanner`).

**External legal/CA confirmation:** L-1 money-flow model · L-2 GST/inclusive pricing/invoice issuer · L-3 TDS · L-4 interim pilot money model · L-5 DPDP notices/retention/backup erasure position · L-6 call recording · L-7 CERT-In log retention · L-8 e-commerce seller-information display · L-9 platform-worker/AP law · L-10 police verification/BGV consent · L-11 fees and damage terms · L-12 TRAI/DLT · L-13 AI processing location.

**Prototype tests that must pass:** S-1 telephony authenticity (before any real IVR state change) · S-2 device matrix (before Gate 9 features) · IVR field test R1/R2 (before real technicians use the IVR) · customer IVR mini-test (before enabling IVR approvals, D-12) · geocoding accuracy on Kurnool addresses (before the pilot) · manual concierge pilot (before final pricing and catalog decisions).
