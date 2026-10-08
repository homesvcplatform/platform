# Housefi — Phase 0: Product Requirements, Architecture & Risks

> Status: **APPROVED by founder with amendments** (2026-10-08) · Original date: 2026-10-08
> **Phase 1 amends parts of this phase.** Where they differ, Phase 1 governs. Every difference is listed in [docs/phase-1/README.md §6](../phase-1/README.md#6-phase-0-contradictions--changes-explicitly-reported). This document is otherwise left unedited.

## How to read this
| Part | Sections |
|---|---|
| [01-product.md](01-product.md) | 1 Vision · 2 Target users · 3 Problems · 4 V1 scope · 5 Excluded features · 6 User journeys (incl. job state machine, IVR scripts) |
| [02-architecture-stack-data.md](02-architecture-stack-data.md) | 7 Architecture (monolith vs microservices, modules, reliability) · 8 Tech stack · 9 Database/entity overview (keys, constraints, indexes, retention, encryption, PII) |
| [03-security-privacy.md](03-security-privacy.md) | 10 Security architecture · 11 Privacy architecture (DPDP) |
| [04-ux-admin-voice-matching.md](04-ux-admin-voice-matching.md) | 12 Customer UX · 13 Technician UX · 14 Admin · 15 Voice/IVR · 16 Matching algorithm |
| [05-delivery.md](05-delivery.md) | 17 Risks · 18 Fraud scenarios · 19 Scalability · 20 Testing · 21 Deployment · 22 Roadmap · 23 Complexity · 24 Questions & assumptions |

## Key decisions proposed (approve / change)

1. **Modular monolith** (one codebase, multiple process roles: api / admin-api / webhook / voice / worker / scheduler). Module = Postgres schema + facade + events via transactional outbox. Built to be extracted later. Microservices rejected for now: our bottleneck is operations and trust, not compute (year-3 ambitious volume ≈ 2–25 jobs/sec).
2. **TypeScript end to end:** NestJS + Drizzle + Zod on the backend, Next.js PWA for customers, React Native (Expo) Android app for technicians (gated by a low-end device spike, with Kotlin fallback), React admin. Runner-up: Kotlin/Spring Modulith.
3. **PostgreSQL 17 + PostGIS** as the system of record. Postgres-backed queue and outbox. Redis only for ephemeral state. AWS Mumbai, with Hyderabad for DR.
4. **Phone-agnostic workforce:** IVR (DTMF-first, pre-recorded native-language prompts) is a first-class channel. **Start/completion codes** prove arrival and completion **without GPS**. Diagnosis for basic-phone technicians is captured by the ops desk in V1.
5. **Diagnosis and immutable quote versions** are first-class. The customer approves on *their own* device/number. The invoice must equal the approved quote, enforced in the DB.
6. **All money rules are data:** versioned, effective-dated, maker-checker-approved rate cards and fees. Each job stores a price snapshot. Money is integer paise, with a double-entry ledger.
7. **Privacy by design:** stage-gated disclosure, masked calling, field-level envelope encryption with per-subject keys (crypto-shredding for erasure), blind-indexed phone numbers, no Aadhaar numbers stored, PII-free logs.
8. **Admin security:** separate identity realm, SSO plus phishing-resistant MFA behind a zero-trust proxy, city-scoped RBAC, audited PII reveal, maker-checker on money, pricing and access.
9. **Matching:** hard filters → weighted, explainable scoring with a **fairness/rotation** factor → sequential cascade with small parallel waves, giving IVR technicians parity with app technicians. Every decision is logged.
10. **AI is assistive only in V1** (categorisation suggestions, voice-note transcription). It never decides prices, penalties, disputes, identity or safety.
11. **Run a concierge pilot in parallel** with Phases 1–4 to validate pricing, IVR comprehension and the repair catalog with real customers and technicians.

## Top blocking questions
Pilot city and languages (Q1–Q2) · marketplace/legal model, invoicing and GST (Q3–Q5) · visit fee and commission/payout model (Q6, Q9) · cash at launch (Q8) · minimum verification before the first job (Q11) · support/safety desk hours (Q13) · team, budget and timeline (Q20). Full list: [05-delivery.md §24](05-delivery.md#24-questions--assumptions-to-resolve-before-coding).
