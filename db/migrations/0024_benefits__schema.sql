-- benefits: the module owns this schema from Gate 2. Skeleton only: no money, feature flag off (Phase 2 non-goal).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA benefits;
COMMENT ON SCHEMA benefits IS 'Skeleton only: no money, feature flag off (Phase 2 non-goal).';
