-- voice: the module owns this schema from Gate 2. IVR call sessions and interactions (tables arrive with Gate 10).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA voice;
COMMENT ON SCHEMA voice IS 'IVR call sessions and interactions (tables arrive with Gate 10).';
