-- catalog (Gate 6, ADR-027 #1): the problem taxonomy a diagnosis names (Phase 1 03 §11 `problem_code` "catalog problem
-- taxonomy"). Problems are per service type, like symptoms: what a technician found, not what the customer reported.
-- Rows are catalog data (fixtures in local / CI); a diagnosis may only name an ACTIVE problem of its job's service type.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE catalog.problems (
  id              uuid PRIMARY KEY,
  service_type_id uuid NOT NULL REFERENCES catalog.service_types(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  names           jsonb NOT NULL,
  sort_order      smallint NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_type_id, code)
);

SELECT platform.classify('catalog.problems', 'I', 'names', 'P');

GRANT SELECT ON catalog.problems TO app_api;
GRANT SELECT, INSERT, UPDATE ON catalog.problems TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.problems TO app_worker;
