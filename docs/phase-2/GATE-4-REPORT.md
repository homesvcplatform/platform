# Gate 4 Review: Catalog, localization, geo

> Date: 2026-10-09 · Decision: **PASS WITH CONDITIONS** (see §6; final on merge of PR #9) · Started under **TE-02** (founder decision 2026-10-09, restriction 7 amended for Gate 4). Local and GitHub CI only, synthetic data only. No AWS, production, real PII, payments, telephony or KYC. Gate 5 **not started**.
> Branch `gate4/catalog-localization-geo`, [PR #9](https://github.com/homesvcplatform/platform/pull/9) (draft; the founder squash-merges). Decisions: [ADR-025](../phase-1/15-architecture-decisions.md#adr-025-gate-4-catalog-localization-and-geo-decisions-phase-2-implementation-addendum) (**Accepted** 2026-10-09).

## 1. Scope delivered vs planned ([03 §Gate 4](03-phase-2-gates.md#gate-4-catalog-localization-geo))
| Planned | Delivered |
|---|---|
| Catalog module: 3 categories, the appliance service types of the approved tree, specializations, symptoms, repair items with service-type-scoped keypad codes, materials, reference prices | `catalog` read side over the Gate 2 tables and the synthetic tree (ADR-020): categories with the service types offered in a city, symptoms, repair items, keypad resolution within a service type, material reference prices at a point in time. Public `GET /v1/catalog/categories` and `GET /v1/catalog/service-types/{id}/symptoms` (anonymous, 5-minute cacheable, rate-limited per IP) |
| Service rules incl. city-scoped `enabled` | Strict rule schema (`enabled` required, unknown keys refused). A city rule overrides the default rule; no rule or an invalid rule = not offered (fail closed). Effective-dated. Changed only through two-person approved change requests (§3) |
| Localization registry (te-IN, en-IN) + enablement gate | `@hsp/localization`: locale registry with fallback te-IN → en-IN; ICU MessageFormat catalogs in the repository (founder decision), checked by CI for completeness, syntax and arguments; locale enablement gate. City languages change only through two-person approved change requests that pass the gate |
| Geo: cities, zones, localities, aliases, adjacency; synthetic Kurnool-like test zones | `geo`: locality search over names and aliases in both scripts (normalised, substring + trigram, ≤ 20), serviceability by locality or point (India only), zone of a locality, shortest travel time over the adjacency graph. Public `GET /v1/geo/localities`, `POST /v1/geo/serviceability`. Synthetic Telugu and Latin aliases added to the fixtures |
| Errata: ADR-020 catalog tree, X-05 | Tree seeded and enforced by the lint list; X-05: no hard-coded locale default, the city's first locale is its primary locale |

Not in Gate 4 (later gates): the price guide (`/v1/catalog/price-guide`, pricing), rate-card / technician-supply bookability checks (booking), geocoding provider, admin UI, catalog content editing beyond service rules (repair items, materials, prices), IVR / SMS / WhatsApp channels.

## 2. Exit criteria evidence
**GitHub CI [run 37920069300](https://github.com/homesvcplatform/platform/actions/runs/37920069300)** (commit `bf10fc4`): every job succeeded (`supply-chain-selftest` skipped by design, TE-01). From the `verify` log: guards, lint (including the new catalog-code rule), typecheck, 0 boundary violations (181 modules), **287/287 unit tests**, squawk "0 issues in 31 files", **test:db 14 files / 208/208 tests** (new in Gate 4: `catalog-geo.db.test.ts` 16, `changes.db.test.ts` 21).

| Exit criterion | Evidence |
|---|---|
| Enabling / disabling a service type for a city changes catalog API output without a deploy | `changes.db.test.ts`: a pricing admin proposes enabling INVERTER for the city, a different city manager approves with a bound passkey step-up, the change executes and the public catalog (a separate `app_api` reader, same process lifetime) lists INVERTER; a second approved change removes it. Also scheduled changes (visible only from their start), REJECT changes nothing, default vs city rules. `catalog-geo.db.test.ts`: rule data changes show up on the next read; hidden types and invalid rules never show |
| Missing-translation check blocks locale enablement | Unit: the repository catalogs pass (`localization.test.ts`); missing, extra, empty, malformed and argument-mismatched messages are reported; the gate refuses a locale with any issue. DB: a city-language proposal with a missing te-IN key is refused (`UI_CATALOG`); a translation that breaks after the proposal blocks execution (stays APPROVED, retry succeeds once fixed); outside `local` / `test` the gate refuses until IVR, template and native-review evidence exist |
| No category / service-type string literals in app code (lint for known codes) | ESLint rule over apps, modules and UI packages, list in `tools/architecture/catalog-codes.json`; `catalog-codes.test.ts` proves it fires on planted literals (string and template), spares tests and fixtures, and that the list equals the fixture tree; the whole repository lints clean |
| Catalog coverage (13 §12) | ≥ 3 appliance service types with distinct specializations offered; keypad `21` resolves to different items under REFRIGERATOR and RO_WATER_PURIFIER; a gas-charge item requires `GAS_REFRIGERATION` |
| Authorization (05 §5.4, matrix row "Edit pricing/rules": PRC M, CM C) | Per matrix column from the seeded role permissions: only PRC may propose, only CM may approve service rules; the checker is never the maker (INV-19); city scope enforced on both sides; all-city rules need GLOBAL grants; decisions need a step-up bound to the request, its payload hash and the decision, used once; a grant step-up can't target a change; a tampered stored payload never executes; Idempotency-Key replay / conflict; execution idempotent per change request |
| Geo | Search by English and Telugu names and aliases, typo tolerance, ≤ 20 results; serviceability by locality and point; inactive locality / zone or paused city not serviceable; outside India refused; travel estimates across zones |

### 2a. Issues found and fixed by CI before green
Test setup only: moving the shared test clock 2 h forward idle-expired the admin sessions (the public reader now has its own clock); a test helper inserted two rules at the same instant without retiring the earlier one, which the exclusion constraint correctly refused (the helper now cuts and retires like execution).

## 3. Security review notes
- **Change requests reuse the Gate 3 step-up binding.** A new step-up operation `backoffice.change.decide` is bound exactly like a grant decision (change request id, payload hash, decision; single use in the decision transaction). Migration 0030 extends the database CHECK accordingly. The WebAuthn / CBOR verification code is unchanged, and passkey ceremonies stay disabled outside `local` / `test` until the independent review (Gate 3 condition): **real two-person approvals of configuration changes therefore also wait for that review.**
- Execution runs in the owning module's own transaction after the decision commits (no cross-module transaction, B4). Idempotent: service rules by a unique key per change request (migration 0031), city languages by compare-and-set on the city version. A stale approval (the city changed in between) never executes and stays APPROVED (`approval_requests` can't be cancelled after a decision).
- Public reads are anonymous by design, return reference data only, and are rate-limited per client IP (`publicRead`, 30 / min). Search text is never logged. The shared (Valkey) limiter store is a deployment condition (Gate 3).
- The ICU validator is custom code but only checks repository files; it never parses user input (ADR-025 #2).
- Telugu UI strings are drafts: **native-speaker review is required before production enablement** (recorded by the gate, which fails closed outside `local` / `test`).

### 3a. Founder decisions (2026-10-09), recorded in ADR-025 (accepted)
1. **City-language permissions:** pricing admin proposes city-language changes with `locales.enable`; city manager approves with `locales.approve`; both city-scoped; proposer and approver must be different people (INV-19); approval needs the existing passkey step-up. Implemented as seeded in migration 0030 and enforced by the change-request policies (tested in `changes.db.test.ts`).
2. **Passkey step-up for configuration approvals:** service-rule and city-language approvals use the existing step-up mechanism (operation `backoffice.change.decide`). The WebAuthn / CBOR verification implementation is not modified. Real configuration approvals stay disabled outside `local` / CI until the independent WebAuthn review passes: every step-up ceremony is refused there (`WEBAUTHN_INDEPENDENT_REVIEW_PASSED = false`, Gate 3 composition test), and a decision can't be made without a step-up.

## 4. Tech debt register delta
| Item | Due |
|---|---|
| Runtime-loaded translation catalogs (repository files for now, founder decision) | When a third language is introduced |
| Evidence sources for IVR prompt coverage, notification templates and native-speaker review (replace the fail-closed rule) | IVR / notification gates, before any production locale enablement |
| Sweeper for change requests left APPROVED after a failed execution (the execute endpoint retries today) | With the worker (Gate 5+) |
| Catalog content changes beyond service rules (service types, repair items, materials, reference prices) through change requests; `catalog.edit` is not yet used | When ops needs them (data is seeded until then) |
| Price guide and rate-card / supply bookability checks | Pricing / booking gates |
| Geocoding provider (`GeoPort`) and geocode cache | With addresses / booking |
| Telugu names for specializations, repair items and materials (English fallback, counted) | Catalog content work before pilot |

## 5. Not verifiable without AWS (TE-01 / TE-02)
CDN caching of the catalog responses, the shared (Valkey) rate-limit store for `publicRead`, and everything already listed in the Gate 3 report §5.

## 6. Conditions (why PASS WITH CONDITIONS)
1. **Real configuration approvals outside local / CI** wait for the independent WebAuthn / CBOR review (Gate 3 condition; founder decision §3a.2).
2. **Production locale enablement** needs the native-speaker review of the Telugu catalogs, IVR prompt coverage and approved notification templates; the gate refuses until those evidence sources exist.
3. **Gate 3 conditions carried unchanged:** independent WebAuthn / CBOR review before any real admin passkey (this now also gates real configuration approvals); AWS-dependent checks; browser-storage E2E (Gate 8); final two-reviewer ruleset (TE-03); the HTTP library choice before the first served endpoint.
4. **Gate 1 and Gate 2 conditions** remain tracked.

## 7. Decision
**PASS WITH CONDITIONS.** ADR-025 accepted (2026-10-09), including the two founder decisions in §3a. Every PR #9 check is green on GitHub (§2). Approver: founder (on merge of PR #9). Gate 5 not started.
