-- backoffice: maker-checker approval requests. Phase 1 03 §13, INV-19 (maker != checker), errata G-9.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA backoffice;

CREATE TABLE backoffice.approval_requests (
  id                           uuid PRIMARY KEY,
  action_type                  text NOT NULL,
  resource_type                text NOT NULL,
  resource_id                  uuid,
  payload                      jsonb NOT NULL,
  payload_hash                 bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  risk_level                   text NOT NULL CHECK (risk_level IN ('MEDIUM','HIGH','CRITICAL')),
  requested_by_admin_id        uuid NOT NULL,
  requested_at                 timestamptz NOT NULL DEFAULT now(),
  required_approver_permission text NOT NULL,
  decided_by_admin_id          uuid,
  decided_at                   timestamptz,
  status                       text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED','CANCELLED')),
  expires_at                   timestamptz NOT NULL,
  CHECK (decided_by_admin_id IS NULL OR decided_by_admin_id <> requested_by_admin_id),   -- INV-19
  CHECK ((status IN ('APPROVED','REJECTED','EXECUTED')) = (decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (expires_at > requested_at)
);
CREATE INDEX approval_pending_ix ON backoffice.approval_requests (status, expires_at) WHERE status = 'PENDING';

SELECT platform.classify('backoffice.approval_requests', 'I', 'payload', 'C');

GRANT USAGE ON SCHEMA backoffice TO app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON backoffice.approval_requests TO app_admin, app_worker;
