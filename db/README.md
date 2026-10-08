# Database (Gate 2)

PostgreSQL 17 + PostGIS. One schema per module (`tools/architecture/modules.json`), plus `ledger` (owned by payments) and the shared `platform` schema. Design: [Phase 1 03](../docs/phase-1/03-database.md), [09 §5](../docs/phase-1/09-payments-ledger.md#5-schema), [10 §6](../docs/phase-1/10-files-and-data.md). Decisions: ADR-023.

## Migrations (`db/migrations`)
- Forward-only SQL: `NNNN_<schema>__<description>.sql`, numbered without gaps. The prefix names the owning schema.
- Each file runs in its own transaction with `lock_timeout = 3s` and `statement_timeout = 60s`. Its SHA-256 is recorded in `platform.schema_migrations`.
- **Never edit an applied migration.** The runner refuses a changed checksum. To undo something, write a new migration (a "forward fix").
- Every new column must be classified in the same migration with `platform.classify(...)` (P / I / C / R, plus `,enc` / `,bidx`). Every `*_enc` column must be registered with `platform.register_encrypted(...)`. Tests fail otherwise.
- Linted in CI by squawk (`.squawk.toml`).

## Roles
| Role | Purpose |
|---|---|
| admin (RDS master / container admin) | `bootstrapCluster` + `bootstrapDatabase` only: roles, extensions, CONNECT/CREATE |
| `migrator` | Owns every schema and object. Runs migrations. **Not a superuser** |
| `app_api`, `app_admin`, `app_webhook`, `app_voice`, `app_worker` | NOLOGIN group roles. Each process's login user is a member of exactly one. Grants per Phase 1 03 §12.1 + G-5 (only `app_worker` writes `ledger.*`) |
| `retention_executor`, `ops_readonly`, `analytics_etl` | No privileges yet (retention job and masked views arrive later) |

## Commands
```bash
pnpm run db:migrate   # HSP_MIGRATOR_DATABASE_URL=postgres://migrator:...@host/db
pnpm run db:seed      # APP_ENV=local|dev|test, synthetic Kurnool fixtures only
pnpm run test:db      # HSP_TEST_DB_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres (THROWAWAY instance only)
```
DB tests run in GitHub Actions against a disposable PostGIS 17 service container. Locally they need Docker; there's no local Docker on the founder's workstation (TE-02).

## Guard error codes (SQLSTATE class `HS`)
`HS001` append-only violation · `HS002` immutable record · `HS003` invalid state transition · `HS010` ledger imbalance / reversal mismatch · `HS020` cross-row invariant (totals, hashes, refund cap).
