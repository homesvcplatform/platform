# Gate 5 Review: Jobs, visits, assignments, state machines

> Date: 2026-10-09 · Proposed decision: **PASS WITH CONDITIONS** (see §6) · Started under **TE-02** (founder decision 2026-10-09, restriction 7 amended for Gate 5). Local and GitHub CI only, synthetic data only. No AWS, production, real PII, payments, telephony or KYC. Gate 6 **not started**.
> Branch `gate5/jobs-lifecycle`, [PR #10](https://github.com/homesvcplatform/platform/pull/10) (draft; the founder squash-merges). Decisions: [ADR-026](../phase-1/15-architecture-decisions.md#adr-026-gate-5-jobs-visits-assignments-and-state-machines-decisions-phase-2-implementation-addendum) (Accepted for the founder decisions #1–#4).

## 1. Scope delivered vs planned ([03 §Gate 5](03-phase-2-gates.md#gate-5-jobs-visits-assignments-state-machines))
| Planned | Delivered |
|---|---|
| Job / Visit / Assignment / RepairOrder aggregates with transition tables + DB transition guards | Transition tables in code (`jobs/domain/transitions.ts`), loaded into `jobs.allowed_transitions` by migration 0033 and enforced by triggers on every insert and status change (HS030). A DB test keeps the two equal |
| Histories | Every status change of the four aggregates writes its history row from a transaction-local actor context (actor, channel, reason, correlation); a change without it fails (HS031). New `jobs.assignment_status_history` (append-only, partitioned) |
| Durable timers + sweeper | Graphile Worker 0.18.0 (ADR-015 / ADR-026 #3), installed by the migrator, row-level-security policies for the worker role only; `platform.schedule_timer` / `cancel_timer` in the state-changing transaction. Timers: match start, matching SLA, technician no-show, customer no-show, visit overrun. 1-minute sweeper (Graphile cron) re-applies anything overdue. Worker composition in `apps/worker` |
| Disclosure service (L0–L3 + customer-verified rule G-4) | `disclosure()` rule (L1 / L2 / L3 / none; offers' L0 is Gate 7) and the technician visit view: the exact address only at L2, only for a verified (or ops-confirmed-by-call) customer, logged to `compliance.disclosure_events` before it is returned; opened through `customers` (SR-06) |
| Presence codes | Start code: HMAC only, issued to the customer on request, 5 wrong attempts lock it (423) and flag ops; START_CODE proof required for ON_SITE (INV-14, DB trigger). Ops arrival override = two-person approved change request (ADR-026 #7). Completion code: DB guard INV-15 (repair visits arrive with Gate 6) |
| Waits | Wait start with a location snapshot near the locality (or ops confirmation); customer no-show after the wait grace; waiting fee on late arrival |
| Cancellation evaluation (policy snapshot) | 06 §10 stages before a quote exists (before assignment, free, late, en route; refused once on site); fee from the city's fixture rate card, frozen in an immutable price snapshot referenced by `job_cancellations`; the accepted fee must match |
| Booking idempotency + soft duplicate check | Idempotency-Key replay, `client_request_id` uniqueness (also under concurrent submits: per-customer advisory lock), `409 POSSIBLE_DUPLICATE` unless confirmed; adult present required (X-34) |
| TCP-3 seam | `BillIssuer` port called inside the jobs transaction through `UnitOfWork` (B4) for a cancellation with a fee and a customer no-show; deterministic placeholder in `payments` (ADR-026 #10), replaced at Gate 11 |
| Founder decisions | Minimal read-only pricing interface (visit fee + snapshot, lifecycle fees; fixture rate cards, NOT FINAL); read-only address interface (`customers`); Graphile Worker; fast-check |

Also: manual ops assignment (`dispatch.assign`, city-scoped, reason, INV-01, INV-03 capacity; DISPATCH and CITY_MANAGER per the §11 matrix, ADR-026 #13 / migration 0034), technician depart / arrive / wait / release, ops-assisted booking (unverified customer) and ops confirmation by call (G-4), customer job view and start-code re-issue.

**Not in Gate 5** (their gates): diagnosis, quotes, repair orders created from approvals, repair completion and the completion-code / ops completion override commands, TCP-2 material usage (Gate 6); offers and the TCP-1 facade called by matching (Gate 7); UI (Gates 8 / 9); IVR and masked-call wait evidence (Gate 10); real bills, payments, ledger (Gate 11). Reschedule, ops cancellation and safety abort are not part of the Gate 5 deliverables and are not built.

## 2. Exit criteria evidence
**GitHub CI [run 37958395465](https://github.com/homesvcplatform/platform/actions/runs/37958395465)** on the final code head `5e9e1b7` of PR #10: every job succeeded (`supply-chain-selftest` skipped by design, TE-01). From the `verify` log: `pnpm install --frozen-lockfile` (lockfile up to date), guards, lint, typecheck, 0 boundary violations (208 modules), **320/320 unit tests** (incl. 19 property tests and 3 supply-chain regression tests), squawk "0 issues in 34 files", **test:db 18 files / 250/250 tests** (new in Gate 5: `jobs.db.test.ts` 23, `jobs-guards.db.test.ts` 14, `timers.db.test.ts` 4, worker `timers.db.test.ts` 1). Later commits on the branch change this report only.

| Exit criterion | Evidence |
|---|---|
| Property tests over transition tables (no illegal transition reachable) | fast-check over the code tables (random walks stay in the table and end only in terminal states; any pair outside the table is refused; reachability; specific 06 "forbidden" moves) and over the database (random from / to pairs on a live visit: accepted exactly when the table allows, otherwise HS030); the DB table equals the code |
| INV-01 | Partial unique index (Gate 2) + a second manual assignment refused once the visit is assigned |
| INV-03 | Per-technician advisory lock + overlapping-window count against the technician's capacity: an overlapping visit is refused (`AT_CAPACITY`), a non-overlapping one accepted |
| Manual-assignment authorization (05 §11 row "Manual assignment": DISP S, CM S) | Per matrix column, an actor built from the seeded role permissions may assign in its own city exactly when the cell allows, and never in another city; a city manager built from the seeded role completes an assignment end to end (`jobs.db.test.ts`) |
| INV-04 | Deferred trigger: a repair order IN_PROGRESS without a linked visit on site fails at commit (HS035); the linked case commits |
| INV-14 | Trigger: ON_SITE without a START_CODE / OPS_OVERRIDE_ARRIVAL proof fails (HS032); the app path writes the proof; the approved ops override writes an audited proof referencing its change request |
| INV-15 | Trigger: a repair visit COMPLETED without a COMPLETION_CODE / OPS_OVERRIDE_COMPLETION proof fails (HS033); a diagnosis visit needs none |
| INV-17 | Time-travel disclosure tests (below) and disclosure events |
| INV-18 | Every status change writes history with actor and channel (job, visit, assignment, repair order); a change without the actor context fails; histories reject DELETE |
| INV-25 | Trigger: CLOSED with an open repair order or a safety hold fails (HS034); allowed once both are cleared |
| Kill-worker timer recovery test | `apps/worker` DB test: worker A takes a due timer and dies mid-task (handler never completes, connections terminated); worker B's sweeper applies the transition exactly once; the late re-run of A's timer is a no-op; B keeps processing fresh timers |
| Duplicate booking test | Key replay (same body + `idempotent-replay`), same client request with a new key (same job), soft duplicate 409 with the existing job id, confirmed separate booking, concurrent double submit → one job |
| Time-travel disclosure tests incl. unverified customer | L1 before window start − 3 h, L2 (address decrypted, disclosure event) inside, L2 for 60 min after a terminal visit, then L3 without the address, none after 30 days; an ops-assisted unverified customer stays L1 inside the window until ops confirms by call; a released technician drops to L3; another technician gets 404 |
| Adult-present field required | Booking without `onsiteAdult`, or with an unknown value, is refused (400); the column is NOT NULL with a CHECK (Gate 2) |

### 2a. Pre-merge fixes (head `5e9e1b7`)
- **City manager manual assignment (ADR-026 #13, migration 0034):** the §11 matrix grants "Manual assignment" to DISP S and CM S, but the Gate 2 seed gave `dispatch.assign` to DISPATCH only. Following the accepted ADR-024 #10 rule (role definitions = 05 §5.3 + what the §11 matrix grants explicitly) and 04 (`dispatch.assign` is the manual-assignment permission), CITY_MANAGER now holds `dispatch.assign`, city-scoped. No new permission or role; it also covers the ops-confirmed wait (ADR-026 #8). 05 §5.3 updated; tested as above.
- **Graphile Worker types pin narrowed (ADR-026 #3):** the override is now `graphile-config@0.0.1-beta.18>@types/node: 24.13.6`, scoped to that exact graphile-config version so an upgrade is resolved and trust-checked afresh. Resolved: `@types/node` 24.13.6 only, `undici-types` 7.18.2, never 6.21.0. `tools/architecture/__tests__/supply-chain.test.ts` checks the pnpm / npm policies, the two documented overrides (workspace and lockfile) and these resolutions.

### 2b. Issues found and fixed by CI before green
- Graphile Worker enables row-level security on its private tables, so the worker role could not take jobs: explicit worker-only policies are created by `installTimerQueue`.
- The exact grant / append-only lists gained the 0033 tables; the Gate 2 test builders set the actor context.
- Idempotency actor keys must use the platform's `user:` / `admin:` prefixes (a `customer:` key violated the CHECK).
- A visit cancelled before its disclosure window opened recorded a close time before the open time (CHECK): a window that never opened now records no open time.
- The matching SLA mixed the database clock (history time) with the application clock: `visits.matching_since` now carries the application time; sweeper queries use typed parameters.
- Test only: access tokens expire after 10 minutes, so time-travel tests sign the technician in again.
- During development fast-check found a disclosure rule gap (a no-show technician kept L1 during the close window), fixed before commit.

## 3. Security review notes
- **Database-enforced lifecycle:** status changes outside the transition table, without an actor context, or skipping the presence proofs fail in the database, whatever the caller.
- **Codes:** never stored in clear (HMAC with a dedicated key); attempt counter survives re-issue; a locked code stays locked; a wrong attempt is committed even though the request fails.
- **Disclosure:** the exact address is decrypted only in the L2 path (customers module, SR-06; the ESLint field-crypto allowlist gains `customers`), after the disclosure event is written; never logged.
- **Ops overrides** use the Gate 4 change-request path with the bound passkey step-up, so they are disabled outside local / CI until the independent WebAuthn review (Gate 3 condition).
- **Queue isolation:** only `app_worker` can touch `graphile_worker`; other roles schedule through two SECURITY DEFINER functions with validated task names and keys.
- **Supply chain:** two new dependencies (founder-approved). Every `@types/node` in graphile-config's range (^22.16.3) needs `undici-types` ~6.21.0, and 6.21.0 is refused by the `no-downgrade` trust policy; no in-range version passes. A types-only override scoped to `graphile-config@0.0.1-beta.18` uses the repository's own trusted Node 24 types (24.13.6) instead, so the refused version is never installed (ADR-026 #3). `trustPolicy`, `minimumReleaseAge`, `blockExoticSubdeps` and `ignore-scripts` are unchanged; no provenance or trust check is bypassed; `supply-chain.test.ts` guards the settings, the overrides and the resolved versions.

## 4. Tech debt register delta
| Item | Due |
|---|---|
| Lifecycle policy values in the config module (fixture defaults now, NOT FINAL) | Config module |
| TCP-1 facade for matching (the internal assignment path exists) | Gate 7 |
| Repair completion command, completion code issue / verification, ops completion override, TCP-2 | Gate 6 |
| Masked-call wait evidence; `visit_code` uniqueness among a technician's active visits (IVR selection aid) | Gate 10 |
| Customer first name / language on the L1 card; problem text, voice note, photos and onsite contact at booking | Gate 8 (customers profile, files) |
| Reschedule, ops cancellation, safety abort | Their gates |
| History partition maintenance (monthly partitions are created 3 months ahead) | Worker job |
| Real bill issuer replacing the placeholder | Gate 11 |

## 5. Not verifiable without AWS (TE-01 / TE-02)
Unchanged from Gate 4 §5, plus the worker process running on the deployed queue database.

## 6. Conditions (why PASS WITH CONDITIONS)
1. **Real ops presence overrides** (and every configuration approval) wait for the independent WebAuthn / CBOR review (Gate 3 condition).
2. **Fixture values only:** rate-card fees and lifecycle policy values are NOT FINAL and must be replaced through the approved configuration path before any real use.
3. **Gate 3 and Gate 4 conditions carried unchanged:** independent WebAuthn / CBOR review; AWS-dependent checks; browser-storage E2E (Gate 8); final two-reviewer ruleset (TE-03); the HTTP library choice before the first served endpoint (Gate 8); production locale enablement evidence.
4. **Gate 1 and Gate 2 conditions** remain tracked.

## 7. Decision
Proposed **PASS WITH CONDITIONS**. Every PR #10 check is green on GitHub for the final code head `5e9e1b7` (§2). Approver: founder (on merge of PR #10). Gate 6 not started.
