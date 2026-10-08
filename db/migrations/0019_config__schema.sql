-- config: the module owns this schema from Gate 2. Runtime configuration and feature flags (tables arrive with Gate 3/4).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA config;
COMMENT ON SCHEMA config IS 'Runtime configuration and feature flags (tables arrive with Gate 3/4).';
