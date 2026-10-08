-- backoffice (Gate 3): admin identities linked to the company IdP, role definitions, scoped grants, admin sessions and
-- admin passkeys (Phase 1 01 §backoffice, 05 §2.5 / §5.3 / §6, SR-03). Admins are never identity.users rows (05 §1).
-- Permissions are defined in code (an enumerated list); role_permissions may only name those (checked by tests).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE backoffice.admin_users (
  id          uuid PRIMARY KEY,
  idp_subject text NOT NULL UNIQUE CHECK (length(idp_subject) BETWEEN 1 AND 255),
  status      text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','OFFBOARDED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 0
);

CREATE TABLE backoffice.roles (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backoffice.role_permissions (
  role_code  text NOT NULL REFERENCES backoffice.roles(code),
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_*]*){1,3}$'),
  PRIMARY KEY (role_code, permission)
);

-- 05 §5.3 / §6: grants come from an executed maker-checker approval. The grantee, the maker and the checker are three
-- different people.
CREATE TABLE backoffice.admin_grants (
  id                  uuid PRIMARY KEY,
  admin_user_id       uuid NOT NULL REFERENCES backoffice.admin_users(id),
  role_code           text NOT NULL REFERENCES backoffice.roles(code),
  scope_kind          text NOT NULL CHECK (scope_kind IN ('GLOBAL','CITIES')),
  city_ids            uuid[] NOT NULL DEFAULT '{}',
  granted_by_admin_id uuid NOT NULL REFERENCES backoffice.admin_users(id),
  approved_by_admin_id uuid NOT NULL REFERENCES backoffice.admin_users(id),
  approval_request_id uuid NOT NULL UNIQUE REFERENCES backoffice.approval_requests(id),
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  CHECK ((scope_kind = 'GLOBAL') = (cardinality(city_ids) = 0)),
  CHECK (granted_by_admin_id <> admin_user_id AND approved_by_admin_id <> admin_user_id AND approved_by_admin_id <> granted_by_admin_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX admin_grants_active_ix ON backoffice.admin_grants (admin_user_id) WHERE revoked_at IS NULL;

-- 05 §2.5: 10 h absolute, 30 min idle, one concurrent session by default. Only the token's SHA-256 is stored.
CREATE TABLE backoffice.admin_sessions (
  id                  uuid PRIMARY KEY,
  admin_user_id       uuid NOT NULL REFERENCES backoffice.admin_users(id),
  token_hash          bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  auth_methods        text[] NOT NULL CHECK (cardinality(auth_methods) >= 1),
  step_up_at          timestamptz,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX admin_sessions_active_ix ON backoffice.admin_sessions (admin_user_id) WHERE revoked_at IS NULL;

-- SR-03 / 05 §2.5: admin passkeys (each admin enrols two). Public keys only.
CREATE TABLE backoffice.admin_webauthn_credentials (
  id              uuid PRIMARY KEY,
  admin_user_id   uuid NOT NULL REFERENCES backoffice.admin_users(id),
  credential_id   text NOT NULL UNIQUE CHECK (credential_id ~ '^[A-Za-z0-9_-]{22,1400}$'),
  public_key_spki bytea NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  backup_eligible boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX admin_webauthn_admin_ix ON backoffice.admin_webauthn_credentials (admin_user_id) WHERE revoked_at IS NULL;

-- Single-use WebAuthn challenges, bound to the admin, the session and (for step-up) the action being authorised.
CREATE TABLE backoffice.webauthn_challenges (
  id             uuid PRIMARY KEY,
  admin_user_id  uuid NOT NULL REFERENCES backoffice.admin_users(id),
  session_id     uuid NOT NULL REFERENCES backoffice.admin_sessions(id),
  purpose        text NOT NULL CHECK (purpose IN ('REGISTRATION','STEP_UP')),
  challenge_hash bytea NOT NULL UNIQUE CHECK (octet_length(challenge_hash) = 32),
  action         text,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'STEP_UP') = (action IS NOT NULL))
);

-- Default role definitions (05 §5.3). Super-admin is break-glass only and has no standing role.
INSERT INTO backoffice.roles (code, description) VALUES
  ('SUPPORT_L1', 'Support L1 (city)'), ('SUPPORT_L2', 'Support L2 (city)'), ('DISPATCH', 'Dispatch (city)'),
  ('VERIFICATION_OFFICER', 'Verification officer (city)'), ('SAFETY_OFFICER', 'Safety officer (region)'),
  ('FINANCE', 'Finance (global)'), ('CITY_MANAGER', 'City manager (city)'), ('PRICING_ADMIN', 'Pricing admin (city)'),
  ('AUDITOR', 'Auditor (global, no PII reveal)'), ('SECURITY_ADMIN', 'Security admin (global)');

INSERT INTO backoffice.role_permissions (role_code, permission)
SELECT r, p FROM (VALUES
  ('SUPPORT_L1', ARRAY['jobs.read','support.book','support.callback','complaints.create','complaints.update','notifications.resend','pii.reveal.phone','support.capture_diagnosis']),
  ('SUPPORT_L2', ARRAY['jobs.read','support.book','support.callback','complaints.create','complaints.update','notifications.resend','pii.reveal.phone','support.capture_diagnosis',
                       'payments.refund.request','goodwill.issue','disputes.investigate','support.record_approval','pii.reveal.address','security.sessions.revoke']),
  ('DISPATCH', ARRAY['dispatch.view_board','dispatch.assign','dispatch.reschedule','dispatch.override_presence','technicians.availability.edit_on_behalf']),
  ('VERIFICATION_OFFICER', ARRAY['verification.read_documents','verification.decide','technicians.onboarding.update','skills.verify']),
  ('SAFETY_OFFICER', ARRAY['safety.read','safety.ack','safety.hold','trust.sanction.propose','trust.suspend_pending_investigation','pii.reveal.*','recordings.read','security.sessions.revoke']),
  ('FINANCE', ARRAY['payments.read','payments.refund.approve','finance.payout.prepare','finance.payout.approve','finance.payout_method.reveal','finance.writeoff','reconciliation.*']),
  ('CITY_MANAGER', ARRAY['pricing.approve','zones.approve','trust.sanction.approve','service_rules.approve','presence_override.approve','analytics.read','audit.read']),
  ('PRICING_ADMIN', ARRAY['pricing.edit','catalog.edit','service_rules.edit']),
  ('AUDITOR', ARRAY['audit.read','config.read','queues.read']),
  ('SECURITY_ADMIN', ARRAY['security.grant','security.grant.approve','security.sessions.revoke','security.access_review','audit.read'])
) AS d(r, perms), unnest(perms) AS p;

SELECT platform.track_updates('backoffice.admin_users');

SELECT platform.classify('backoffice.admin_users', 'I', 'idp_subject', 'C');
SELECT platform.classify('backoffice.roles', 'I');
SELECT platform.classify('backoffice.role_permissions', 'I');
SELECT platform.classify('backoffice.admin_grants', 'I');
SELECT platform.classify('backoffice.admin_sessions', 'I', 'token_hash', 'R');
SELECT platform.classify('backoffice.admin_webauthn_credentials', 'I');
SELECT platform.classify('backoffice.webauthn_challenges', 'I', 'challenge_hash', 'R');

-- admin-api only (05 §1: separate realm). No DELETE anywhere for app_admin (03 §12.1).
GRANT SELECT, INSERT, UPDATE ON backoffice.admin_users, backoffice.admin_grants, backoffice.admin_sessions,
      backoffice.admin_webauthn_credentials, backoffice.webauthn_challenges TO app_admin;
GRANT SELECT ON backoffice.roles, backoffice.role_permissions TO app_admin;
GRANT SELECT ON backoffice.admin_users, backoffice.admin_grants, backoffice.admin_sessions TO app_worker;
