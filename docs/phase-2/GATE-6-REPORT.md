# Gate 6 Review: Diagnosis and quote engine

> Date: 2026-10-10 · Proposed decision: **PASS WITH CONDITIONS** (see §6) · Under **TE-02** (founder approval 2026-10-09). Local and GitHub CI only, synthetic data only. No AWS, production, real PII, payments, telephony or KYC. Gate 7 **not started**.
> Branch `gate6/diagnosis-quotes`, [PR #12](https://github.com/homesvcplatform/platform/pull/12) (draft; the founder squash-merges). Decisions: [ADR-027](../phase-1/15-architecture-decisions.md#adr-027-gate-6-diagnosis-quotes-and-repair-orders-decisions-phase-2-implementation-addendum) (Accepted for the founder decisions D1–D14).

## 1. Scope delivered vs planned ([03 §Gate 6](03-phase-2-gates.md#gate-6-diagnosis-and-quote-engine))
| Planned | Delivered |
|---|---|
| Diagnosis drafts / submission (app + ops-desk capture) | `diagnosis` module: draft create / replace (optimistic version) / server-priced preview / submit by the visit's ACTIVE technician; problem taxonomy (`catalog.problems`, ADR-027 #1); a correcting INITIAL diagnosis supersedes the earlier one before any decision; ADDITIONAL_FINDING during repair. Ops-desk capture (`support.capture_diagnosis`, city-scoped) on a bridged call through a call-evidence port, local / test only (ADR-027 #3) |
| Pricing engine reading configurable rate cards (fixtures only, Model B and C configs; no final values) | Pure engine (`pricing/domain/quote.ts`): labour from the rate card, materials from the city reference (proposed price within ±20 % or a reason), markup, platform fee (flat or %), `VISIT_FEE_CREDIT` fee rule (ADR-027 #4, migration 0036), technician shares (largest remainder), integer paise maths in `@hsp/money`. Model B (ACTIVE) and Model C (DRAFT) fixtures, NOT FINAL |
| Quote versions + items incl. `VISIT_FEE_CREDIT`; content hash | Submission re-prices on the server (a different result than the preview → 409 `PRICE_RECALCULATED`), writes the immutable snapshot (INV-21, pricing's own transaction), freezes version + items, SHA-256 content hash over the lines (with their text keys) and totals, presents it (one PRESENTED per quote, the previous one WITHDRAWN), expiry timer, quote-version history (INV-18, migration 0037) |
| Approval channels: app session, signed link (fragment token, SR-05) + OTP; ops-recorded channel implemented but flag-off | Session approval / rejection (hash-bound, own job only, step-up above the threshold); signed link: 256-bit token delivered once to the customer's channel (stored as a hash, never logged), POSTed in the body, `Referrer-Policy: no-referrer`, generic page for preview agents, OTP to the registered number through an identity port (ADR-027 #13), single successful decision. Ops-recorded channel with G-9 separation of duties behind `opsRecordedApprovalEnabled = false` (ADR-027 #20) |
| Q-A repair-option logic | Qualified diagnosing technician: same visit now (every 06 §3 guard), same technician later, specialist; not qualified: specialist only, with the technical reason; change orders keep the order's performer |
| Repair order creation from `QuoteApproved` | Outbox relay + idempotent jobs consumer (ADR-027 #14): same-visit attach (guards re-checked; fallback with the reason), else AWAITING_SCHEDULE with the preference; customer scheduling creates the repair visit (new codes); materials confirmed before departure; arrival starts the order; partial repair BLOCKS it (D6); cancellation before departure bills the visit fee |
| Change-order (v2) flow | ADDITIONAL_FINDING → v(n+1) = approved lines + new finding, same rate card, shorter expiry; the order is CHANGE_PENDING (work on new items paused: completion refused); approval supersedes v(n) and moves the order; rejection / expiry keeps v(n) in force |

Also: diagnosis-visit checkout (and the system auto-checkout 30 min after presentation, flagged), repair completion with the customer's completion code (INV-15) or an approved ops override (change request), TCP-2 material usage (≤ quoted) and TCP-3 placeholder bills (visit fee; approved − unused material + waiting fees, INV-09), the margin-warning hook (1.1/06 formulas, ADR-027 #12), quote expiry sweeper, error codes `PRICE_RECALCULATED`, `QUOTE_CHANGED`, `QUOTE_EXPIRED`, `OPTION_UNAVAILABLE`, `CHANGE_PENDING`, `CUSTOM_LABOUR_OUT_OF_BAND`, `FEATURE_DISABLED`.

**Not in Gate 6** (their gates): matching of repair visits / direct offers (Gate 7; repair visits are assigned manually by ops); UI (Gates 8 / 9); photos, voice notes, receipts, after-photo rules and free-text notes (files / key class, ADR-027 #2); IVR approval and real call evidence (Gate 10); real bills, payments, ledger, diagnosis payout postings (Gate 11). No HTTP library is chosen and nothing is served.

## 2. Exit criteria evidence
**GitHub CI [run 37975433813](https://github.com/homesvcplatform/platform/actions/runs/37975433813)** on code head `96ff362` of PR #12: every job succeeded (`supply-chain-selftest` skipped by design, TE-01). From the `verify` log: `pnpm install --frozen-lockfile` (lockfile up to date), guards, lint, typecheck, 0 boundary violations (224 modules), **359/359 unit tests** (new: `diagnosis.test.ts` 15, `quote.test.ts` 8, `margin.test.ts` 6, `money.test.ts` 6; jobs tests extended), squawk "0 issues in 38 files", **test:db 21 files / 284/284 tests** (new: `diagnosis.db.test.ts` 23, `quote-recorded.db.test.ts` 3, worker `relay.db.test.ts` 3, `invariants.db.test.ts` +5). The "Sensitive paths review" workflow fails as on every PR (it needs two human reviewers; not a required check under TE-03). Later commits on the branch change docs only.

| Exit criterion | Evidence |
|---|---|
| INV-05 (version immutable once presented) | Gate 2 triggers re-run, plus as the api role: UPDATE / DELETE of quote items → 42501 (no grant), UPDATE of version totals → HS002, INSERT of an item into a presented version → HS002, snapshots unwritable (42501) |
| INV-06 (latest PRESENTED version, the hash the customer saw) | Stale hash → 409 `QUOTE_CHANGED`; an old (WITHDRAWN) version → 409 with the latest version number; the approval trigger refuses a non-PRESENTED version or a different hash |
| INV-07 (≤ 1 APPROVED version) | Two concurrent approvals → one 200, one 409, one decision row; an approval racing a new version → exactly one wins; a change order supersedes only the APPROVED version (D11: PRESENTED → SUPERSEDED refused, HS003) |
| INV-08 (customer only, own channel) | Another customer → 404; a technician session → 404; app session evidence recorded; signed link needs the token and the OTP to the registered number (wrong code → `OTP_INVALID`, a used link → 404); ops-recorded channel `FEATURE_DISABLED` by default and, when enabled for the test, ≤ cap only |
| INV-09 (bill ≤ approved + policy fees − unused material) | Completion bills approved total − unused material (+ waiting fees): 173 900 − 60 000 with one of two quoted thermostats used; property tests: line = round(qty × unit), totals = Σ signed lines |
| INV-21 (snapshot at version creation, unchanged later) | Version references a `gate6-quote-1` snapshot (inputs / outputs); snapshots are append-only; change orders are priced with the approved version's card |
| Change-order integration test (no work on new items before approval) | ADDITIONAL_FINDING → v2 PRESENTED → order CHANGE_PENDING → completion refused (409 `CHANGE_PENDING`); the TCP-2 recorder refuses usage while a change is pending and for an unapproved version; approval supersedes v1 and moves the order to v2 (history reason `QUOTE_APPROVED`); a further change rejected → v2 stays; completion bills v2 |
| Separation-of-duties tests (G-9) | `quote-recorded.db.test.ts`: the diagnosis capturer can be neither recorder nor verifier, recorder ≠ verifier, verifier needs the permission and a fresh step-up, a recorded call and the read-back code are required; the decision row records all three ids (Gate 2 CHECK backs it) |
| Pricing property tests (totals = Σ signed lines, rounding) | fast-check: totals = Σ signed lines = items − discount − credit + tax, amounts ≥ 0, credit ≤ visit fee, line = round half-up (equal to the exact decimal reference), deterministic; largest-remainder splits sum exactly; Model B and C fixtures |
| Margin-warning hook from the simulator formulas | The pure formulas reproduce every row of the 1.1/06 §2 tables for Models A, B and C; the hook flags A S1–S3, B S4, C none among the model-dependent scenarios |

Also covered: Q-A options (not-qualified technician → specialist only, `OPTION_UNAVAILABLE`), step-up above ₹3,000 (fixture), same-visit attach and its fallback (`VISIT_ENDED`), separate repair visit (materials confirmed before departure, arrival starts the order), partial repair (BLOCKED, D6), repair-order cancellation (visit fee, job CANCELLED), rejection and expiry (visit fee bill), no-repair checkout and the flagged auto-checkout, ops completion override (OPS_OVERRIDE_COMPLETION proof, ADMIN usage), event replay (one repair order, one `processed_events` row), the relay (per-aggregate order with two relays, dead letter after retries, wake-up via the Graphile runner < 5 s), the quote-version history (and HS031 without an actor context), link tokens never in logs.

### 2a. Issues found and fixed by CI before green
- Completing a repair visit before its disclosure window opened stored a close time before the open time (CHECK): as on the Gate 5 terminal path, a window that never opened now records no open time.
- New columns (`diagnoses.draft_lines`, `outbox.attempts`, `outbox.last_attempt_at`) needed classification tags; the exact append-only list gained the quote-version history.

## 3. Security review notes
- **Server-only prices:** clients send references and quantities; every price comes from the rate card / reference price; submission re-prices; the snapshot and version are immutable (triggers + grants: the api role can't update or delete items, and can't touch snapshots).
- **Hash-bound, single decisions:** the database refuses a decision on anything but the PRESENTED version with its hash, a second decision on a version, and a second APPROVED version; a change order supersedes only an APPROVED version (D11).
- **Customer-only approval (INV-08):** policies give the decision to the job owner's session only; the link channel needs the token AND the OTP to the registered number (SR-05); the ops-recorded channel is off, and when enabled enforces recorder ≠ verifier ≠ capturer in code and in the Gate 2 CHECK (G-9).
- **No work before approval (INV-04):** the TCP-2 recorder re-checks the approved version under the quote lock in the completion transaction; repair orders start only from an APPROVED version.
- **Secrets:** link tokens and codes are never stored in clear or logged (log canary in the tests); OTP limits per phone apply to link codes.
- **Relay:** worker role only; per-aggregate order; exactly-once effects; failures go to dead letters with a code label, never a message.

## 4. Tech debt register delta
| Item | Due |
|---|---|
| Where the custom-labour band is configured (all custom labour refused until then) | Founder decision |
| Verifier workflow of the ops-recorded channel (D-11 / D-15) | Founder / legal |
| Photos, receipts, after-photo rule, free-text notes | Gate 8 (files) / key decision |
| Repair visit matching (direct offer to the same technician, cascade) | Gate 7 |
| IVR diagnosis desk / approval / completion (voice role grants for TCP-2) | Gate 10 |
| Real bills (prior-payment credit, G-8 ledger postings, INV-23 diagnosis payout) | Gate 11 |
| Policy values in the config module (quote expiry, thresholds, waits) | Config module |
| Material-readiness timer at departure-due; diagnosis void command | Later gate / permission decision |

## 5. Not verifiable without AWS (TE-01 / TE-02)
Unchanged from Gate 5 §5, plus the relay on the deployed worker / queue database.

## 6. Conditions (why PASS WITH CONDITIONS)
1. **Fixture values only:** rate cards, fee rules (incl. visit-fee credit and platform fee) and diagnosis / lifecycle policy values are NOT FINAL.
2. **Open decisions:** custom-labour band location; ops-recorded verifier workflow (D-11 / D-15 pending).
3. **Gate 3, 4 and 5 conditions carried unchanged** (independent WebAuthn / CBOR review — which also gates the ops completion override —, AWS-dependent checks, browser E2E, final two-reviewer ruleset, HTTP library before the first served endpoint, production locale evidence).
4. **Gate 1 and Gate 2 conditions** remain tracked.

## 7. Decision
Proposed **PASS WITH CONDITIONS**. Every PR #12 check is green on GitHub for code head `96ff362` (§2). Approver: founder (on merge of PR #12). Gate 7 not started.
