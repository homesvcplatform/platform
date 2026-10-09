-- catalog (Gate 4, ADR-025 #5 / #7): an approved service-rule change executes exactly once. A change request sets one
-- (service type, city or default) rule, so (approval_request_id, service_type_id, city) is unique among rows written
-- by change requests. The synthetic seed's fixture approval covers many rows with distinct service types, which the
-- key allows.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- service_rules is small reference data (tens of rows per city); the runner wraps each file in a transaction, where
-- CREATE INDEX CONCURRENTLY can't run.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX service_rules_change_request_uq ON catalog.service_rules
  (approval_request_id, service_type_id, (coalesce(city_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE approval_request_id IS NOT NULL;
