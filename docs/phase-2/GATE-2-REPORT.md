# Gate 2 Review: Database foundation, migrations, constraints

> Date: 2026-10-09 · Decision: **PASS WITH CONDITIONS** (see §6) · Started under **TE-02** (narrow solo-development exception, founder go 2026-10-09). Local and GitHub CI only, throwaway PostgreSQL 17 + PostGIS, synthetic data only, no AWS. Gate 3 **not started**.
> Branch `gate2/database-foundation`, [PR #5](https://github.com/homesvcplatform/platform/pull/5) (draft; the founder squash-merges). Decisions: [ADR-023](../phase-1/15-architecture-decisions.md#adr-023-gate-2-database-foundation-decisions-phase-2-implementation-addendum) (Proposed: accepted as part of this review).

## 1. Scope delivered vs planned ([03 §Gate 2](03-phase-2-gates.md#gate-2-database-foundation-migrations-constraints))
| Planned | Delivered |
|---|---|
| Migration runner + `squawk` | `@hsp/db` `runMigrations`: forward-only, SHA-256 checksums in `platform.schema_migrations`, advisory lock, one transaction per file (`lock_timeout 3s`, `statement_timeout 60s`). Refuses a superuser, an edited applied migration, or a database ahead of the directory. CLI `pnpm run db:migrate`. squawk v2.65.0 (SHA-256-verified binary) in the required `verify` job, `.squawk.toml` with 4 justified exclusions |
| Schemas per module | 25 migrations `db/migrations/0001–0025`. Every module in `tools/architecture/modules.json` owns a schema, plus `ledger` (payments) and shared `platform`. All owned by the non-superuser `migrator`. Admin-only bootstrap (`bootstrapCluster` / `bootstrapDatabase`) creates roles and extensions (postgis, btree_gist, pg_trgm, pgcrypto) |
| Per-process DB roles and grant matrix (G-5) | NOLOGIN group roles `app_api`, `app_admin`, `app_webhook`, `app_voice`, `app_worker`. `retention_executor`, `ops_readonly` and `analytics_etl` have no grants yet. Grants follow Phase 1 03 §12.1 literally. Only `app_worker` writes `ledger.*`; `app_webhook` can only INSERT raw provider events. `@hsp/db` `DB_ROLE_FOR_PROCESS`, `createRolePool` + `assertRuntimeIdentity` |
| Append-only triggers | `platform.make_append_only(table)`: row + TRUNCATE triggers (HS001) on audit, consent, disclosure, outbox history, price snapshots, ledger, raw provider events, approvals, ratings, etc. Partitions inherit the guard |
| Partition templates | `platform.ensure_monthly_partitions(parent, back, ahead)` (UTC months, last month to +3). pg_partman is adopted on the managed DB (ADR-023 #4) |
| Core tables for slice modules | identity, customers, workforce, catalog, geo, pricing, jobs, diagnosis, matching, payments + ledger (09 §5), warranty, trust (ratings / aggregates / blocks), compliance (audit / consent / disclosure), files (10 §6), platform (outbox, idempotency, messaging), `backoffice.approval_requests` (INV-19). Empty owned schemas for config, verification, voice, comms, ai, benefits |
| Key-subject registry (G-7 / SR-07) | `platform.encrypted_columns` filled by `platform.register_encrypted(...)` in each migration. `platform.archive_policies` + view `platform.archive_columns` (P / I columns only) |
| Query-tag fitness test | B2 `assertModuleOwnsSql` / `referencedSchemas` (`@hsp/db` query guard) + repo guard `tools/architecture/check-sql-ownership.mjs` (`pnpm run guard:sql-ownership`, in `pnpm run ci`): a migration may only touch the schema its file prefix names (plus `platform` shared helpers). B4 `UnitOfWork.join` allows only the documented TCPs. B2, B4, B10 now active (`tools/architecture/README.md`) |
| Synthetic seed loader | `@hsp/testing` Kurnool fixtures (city KNL, 2 zones, 12 localities, catalog tree, 13 service types / 8 enabled, symptoms, repair items with per-service-type keypad codes, materials, rate cards Model B ACTIVE + Model C DRAFT labelled NOT FINAL, 7 technicians, 4 customers). Deterministic UUIDv7 ids (`fixtureId`). Idempotent `loadSyntheticSeed`; `pnpm run db:seed` refuses unless `APP_ENV` is local / dev / test. Phones only in the reserved fake range `+9100000xxxxx`, stored encrypted + blind index + mask |

## 2. Exit criteria evidence
DB tests run only in GitHub Actions (`pnpm run test:db` in the required `verify` job, against a disposable `postgis/postgis:17-3.5` service container pinned by digest). There's no Docker on the founder's workstation (TE-02).

| Exit criterion | Evidence |
|---|---|
| DB constraint tests green: INV-01, 05, 07, 10, 11, 12, 16, 19 at SQL level | `invariants.db.test.ts` (27 tests): INV-01 one ACTIVE assignment; INV-05 presented quote immutable + G-8 sums; INV-06/07 decision on the presented version with its hash, one APPROVED per quote; INV-10 invoice = bill lines, immutable; INV-11 / ledger L1–L4, L10 (balanced at commit, no update/delete, idempotency key, exact-mirror reversal, no stored-value subtype); INV-12 refund cap; INV-16 one rating; INV-19 maker ≠ checker. Also INV-21, 22, 24, 28 and G-9 |
| Grant matrix test (non-worker roles can't write the ledger; webhook role insert-only) | `grants.db.test.ts` (16 tests): catalogue checks over `information_schema` for every role and table, plus behaviour tests run *as* each role (`SET ROLE`) |
| Append-only UPDATE / DELETE rejected | `append-only.db.test.ts` (4 tests): exact trigger list, partitions included; UPDATE / DELETE / TRUNCATE refused even for the owner |
| Migrations reversible-by-forward-fix rehearsed | `migrations.db.test.ts` (8 tests): expand migration, then a forward-fix migration restores the exact schema fingerprint. Also: failed migration fully rolled back, edited migration refused, re-run is a no-op, migrator / runtime roles have no elevated attributes |
| No PII column without a classification tag | `classification.db.test.ts` (10 tests): every column tagged P / I / C / R; `*_enc` ⇔ `,enc`, `*_bidx` ⇔ `,bidx`; secret-derived columns Restricted; INV-27 (no column could hold plaintext Aadhaar / card / UPI PIN / OTP / IVR PIN); every encrypted column registered with a uuid subject; archives hold no C / R columns |
| (supporting) partitions, seed | `partitions.db.test.ts` (4), `seed.db.test.ts` (7) |

**GitHub CI [run 37846988688](https://github.com/homesvcplatform/platform/actions/runs/37846988688)** (commit `1bad0f9`), read from the job logs: `verify` PASS (no-prod and workspace guards, SQL-ownership guard, lint, typecheck, 0 boundary violations, **134/134** unit tests, squawk "0 issues in 25 files", **test:db 7 files / 76/76 tests**). `secrets-scan`, `sca`, `iac` and `image` PASS. `sast` **FAILED** with 2 Semgrep findings in the fixture crypto (§4). They were fixed at the root, not suppressed. The follow-up commit's run is in §2a.

### 2a. Re-run after the SAST fix
**[CI run 37847727389](https://github.com/homesvcplatform/platform/actions/runs/37847727389)** (commit `20dd0af`): **every job succeeded**. `supply-chain-selftest` was skipped by design (no AWS, TE-01). Read from the job logs:
| Job | Result |
|---|---|
| `verify` | **PASS**: guards, lint, typecheck, 0 boundary violations (113 modules), **135/135** unit tests, squawk "Found 0 issues in 25 files", **test:db 7 files / 76/76 tests** (invariants 27, grants 16, classification 10, migrations 8, seed 7, append-only 4, partitions 4) |
| `sast` | **PASS**: Semgrep 368 rules on 383 files, **0 findings**; planted-code self-test still detects 3 |
| `secrets-scan`, `sca`, `iac`, `image` | **PASS** |

## 3. Errata applied
G-5 (per-process grants, worker-only ledger writes) · G-7 (key-subject registry + archive policy) · G-8 (bill / quote line types, credit-line signs, sums at commit) · G-9 (CHECKs: ops-recorded approval separation of duties) · X-05 (`preferred_locale` has no default) · X-24 / X-34 (payment preference and on-site adult required, closed sets) · Q-C (`preferred_language` te / en / other). Deviations from the Phase 1 DDL text are listed in ADR-023 #7. Each one tightens the rules or makes the spec compilable.

## 4. Security review notes
- **SAST findings on the first push (fixed):** (1) `createDecipheriv` for AES-256-GCM had no `authTagLength`, so a truncated tag could be accepted. Both cipher and decipher now pin a 16-byte tag, and decrypt rejects truncated envelopes (new unit test). (2) The fixture blind-index pepper was a string literal. It now comes from the same documented public-label derivation as the fixture encryption key. That crypto is test-only by design (ADR-023 #10) and is replaced by `@hsp/security` at Gate 3. No `nosemgrep` was added.
- Runtime roles are NOLOGIN groups without SUPERUSER / CREATEROLE / CREATEDB / BYPASSRLS. PUBLIC has no table privileges in any application schema. Runtime roles can't create partitions or DDL.
- Guard functions that need cross-row reads (`guard_refund_total`) are `SECURITY DEFINER` with a pinned `search_path`.
- No real PII: the seed is synthetic, phones are in a reserved fake range, and the seed CLI refuses non-local environments. No AWS, no credentials, no production.
- Supply chain: new deps `pg` 8.23.0, `@types/pg` 8.23.1, `uuid` 14.0.2 (all past the minimum-release-age window). Transitive `rolldown` pinned to 1.2.11 because the Gate 1 lockfile held a one-day-old version (ADR-023 #12). The squawk binary and the PostGIS image are pinned by SHA-256 / digest.

## 5. Tech debt register delta
| Item | Due |
|---|---|
| Fixture envelope crypto → `@hsp/security` field crypto (per-subject DEKs, KMS / kms-local, encryption context) | Gate 3 |
| Status-transition guard triggers for jobs / visits / assignments / repair orders | Gate 5 (with the state machines) |
| Tables for trust complaints / disputes / sanctions / safety, verification, voice, comms, ai, benefits | Their gates |
| Masked views + grants for `retention_executor`, `ops_readonly`, `analytics_etl` | With the retention job / analytics |
| Drizzle table definitions for module repositories | Gate 3+ (ADR-023 #1) |
| pg_partman, pgaudit, pg_stat_statements | Managed database (TE-01) |

## 6. Conditions (why PASS WITH CONDITIONS)
1. **Managed-database verification (TE-02 restriction 8):** re-run the migrations, the grant matrix and all DB tests against the managed PostgreSQL 17 (RDS) when AWS resumes under TE-01, and adopt pg_partman / pgaudit there. Until then Gate 2 stays PASS WITH CONDITIONS.
2. **ADR-023 acceptance** by the founder (it is Proposed with this review).
3. **ADR-023 #9 open item:** `app_voice` can't issue the TCP-3 bill under the literal 03 §12.1 grants. The founder decides by Gate 10/11: either grant `app_voice` INSERT on `payments.bills` / `bill_lines`, or route IVR completion through `api`. Either answer is a forward-fix migration.
4. Gate 1 conditions are unchanged: G7 is interim (TE-03), G8 / G9 are pending, and the AWS proofs are deferred (TE-01).

## 7. Decision
**PASS WITH CONDITIONS**. Every PR #5 check is green on GitHub (§2a). The conditions are in §6. Approver: founder (on merge of PR #5). Gate 3 not started.
