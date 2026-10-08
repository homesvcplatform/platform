-- verification: the module owns this schema from Gate 2. Identity / skill verification (tables arrive with technician onboarding).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA verification;
COMMENT ON SCHEMA verification IS 'Identity / skill verification (tables arrive with technician onboarding).';
