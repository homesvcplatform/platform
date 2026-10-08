-- ai: the module owns this schema from Gate 2. Assistive AI requests (fake provider only; tables arrive with the flagged features).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA ai;
COMMENT ON SCHEMA ai IS 'Assistive AI requests (fake provider only; tables arrive with the flagged features).';
