-- identity: people who log in by phone, their per-person data keys, devices, sessions, OTP challenges, IVR PINs.
-- Phase 1 03 §4, errata X-05 (no hard-coded locale default), INV-27 (no plaintext OTP / PIN).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA identity;

CREATE TABLE identity.users (
  id                    uuid PRIMARY KEY,
  phone_enc             bytea,
  phone_bidx            bytea,
  phone_masked          text,
  preferred_locale      text NOT NULL CHECK (preferred_locale ~ '^[a-z]{2}-[A-Z]{2}$'),   -- X-05: no DB default
  status                text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','ERASED')),
  suspended_reason_code text,
  erased_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 0,
  CHECK ((status = 'ERASED') = (phone_enc IS NULL AND phone_bidx IS NULL AND erased_at IS NOT NULL)),
  CHECK (status <> 'ERASED' OR phone_masked IS NULL),
  CHECK (phone_bidx IS NULL OR octet_length(phone_bidx) = 16)
);
CREATE UNIQUE INDEX users_phone_bidx_uq ON identity.users (phone_bidx) WHERE phone_bidx IS NOT NULL;

CREATE TABLE identity.subject_keys (
  user_id      uuid PRIMARY KEY REFERENCES identity.users(id),
  wrapped_dek  bytea,
  kms_key_arn  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  CHECK ((wrapped_dek IS NULL) = (destroyed_at IS NOT NULL))
);

CREATE TABLE identity.devices (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES identity.users(id),
  platform          text NOT NULL CHECK (platform IN ('ANDROID_APP','WEB')),
  app_version       text,
  os_version        text,
  push_token_enc    bytea,
  integrity_verdict text CHECK (integrity_verdict IN ('MEETS_DEVICE','MEETS_BASIC','FAILED','UNKNOWN')),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE INDEX devices_user_ix ON identity.devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES identity.users(id),
  device_id           uuid REFERENCES identity.devices(id),
  surface             text NOT NULL CHECK (surface IN ('CUSTOMER_WEB','TECHNICIAN_APP','AGENT_WEB')),
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
CREATE INDEX sessions_user_active_ix ON identity.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.refresh_tokens (
  id             uuid PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES identity.sessions(id),
  family_id      uuid NOT NULL,
  token_hash     bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  replaced_by_id uuid,
  revoked_at     timestamptz
);
CREATE INDEX refresh_tokens_family_ix ON identity.refresh_tokens (family_id);
CREATE INDEX refresh_tokens_session_ix ON identity.refresh_tokens (session_id);

CREATE TABLE identity.otp_challenges (
  id           uuid PRIMARY KEY,
  phone_bidx   bytea NOT NULL CHECK (octet_length(phone_bidx) = 16),
  purpose      text NOT NULL CHECK (purpose IN ('LOGIN','STEP_UP','QUOTE_LINK_APPROVAL','PHONE_CHANGE','CONSENT')),
  channel      text NOT NULL CHECK (channel IN ('SMS','WHATSAPP','VOICE')),
  code_hmac    bytea NOT NULL CHECK (octet_length(code_hmac) = 32),   -- HMAC only: the code itself is never stored
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip_hash      bytea,
  device_hash  bytea,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_recent_ix ON identity.otp_challenges (phone_bidx, created_at DESC);
CREATE INDEX otp_expiry_ix ON identity.otp_challenges (created_at);

CREATE TABLE identity.ivr_credentials (
  user_id         uuid PRIMARY KEY REFERENCES identity.users(id),
  pin_hash        text NOT NULL CHECK (pin_hash LIKE '$argon2id$%'),      -- Argon2id PHC string, never the PIN
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    timestamptz,
  last_changed_at timestamptz NOT NULL,
  set_via         text NOT NULL CHECK (set_via IN ('IVR_SELF','AGENT_ASSISTED_VERIFIED','APP')),
  version         int NOT NULL DEFAULT 0
);

SELECT platform.track_updates('identity.users');

SELECT platform.classify('identity.users', 'I', 'phone_enc', 'C,enc', 'phone_bidx', 'C,bidx');
SELECT platform.classify('identity.subject_keys', 'I', 'wrapped_dek', 'R');
SELECT platform.classify('identity.devices', 'I', 'push_token_enc', 'C,enc');
SELECT platform.classify('identity.sessions', 'I');
SELECT platform.classify('identity.refresh_tokens', 'I', 'token_hash', 'R');
SELECT platform.classify('identity.otp_challenges', 'I', 'phone_bidx', 'C,bidx', 'code_hmac', 'R', 'ip_hash', 'C', 'device_hash', 'C');
SELECT platform.classify('identity.ivr_credentials', 'I', 'pin_hash', 'R');

SELECT platform.register_encrypted('identity.users', 'phone_enc', 'USER', 'id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('identity.devices', 'push_token_enc', 'USER', 'user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');

GRANT USAGE ON SCHEMA identity TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT, UPDATE ON identity.users, identity.devices, identity.sessions, identity.refresh_tokens,
      identity.otp_challenges, identity.ivr_credentials TO app_api;
GRANT SELECT, INSERT ON identity.subject_keys TO app_api;
GRANT SELECT, UPDATE ON identity.users, identity.devices, identity.sessions, identity.refresh_tokens TO app_admin;
GRANT SELECT, INSERT, UPDATE ON identity.ivr_credentials TO app_admin;
GRANT SELECT ON identity.users TO app_voice;
GRANT SELECT, UPDATE ON identity.ivr_credentials TO app_voice;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.users, identity.subject_keys, identity.devices, identity.sessions,
      identity.refresh_tokens, identity.otp_challenges, identity.ivr_credentials TO app_worker;
