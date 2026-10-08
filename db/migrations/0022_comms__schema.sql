-- comms: the module owns this schema from Gate 2. Notifications and delivery receipts (tables arrive with Gate 3).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA comms;
COMMENT ON SCHEMA comms IS 'Notifications and delivery receipts (tables arrive with Gate 3).';
