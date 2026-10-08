-- identity (Gate 3): per-data-class subject keys (SR-06), web session secrets (SR-02 / G-6) and the IVR PIN 24-hour
-- failure window (Phase 1 05 §2.3). The altered tables hold no rows in any environment (Phase 2 has no production and
-- the synthetic seed doesn't write them), so the lock-related squawk rules waived below have nothing to lock.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- SR-06: one data key per (subject, data class), each wrapped by that class's KMS key, so a role without the class
-- grant can't unwrap it. Replaces the one-key-per-user primary key.
ALTER TABLE identity.subject_keys ADD COLUMN data_class text NOT NULL DEFAULT 'pii-contact';
ALTER TABLE identity.subject_keys ALTER COLUMN data_class DROP DEFAULT;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE identity.subject_keys ADD CONSTRAINT subject_keys_data_class_ck
  CHECK (data_class IN ('pii-contact','pii-address','kyc','recordings','restricted-attributes'));
ALTER TABLE identity.subject_keys DROP CONSTRAINT subject_keys_pkey;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE identity.subject_keys ADD CONSTRAINT subject_keys_pkey PRIMARY KEY (user_id, data_class);

-- SR-02 / G-6: browser sessions (customer PWA, field-agent web) authenticate with an opaque cookie secret; only its
-- SHA-256 is stored. App sessions use access + refresh tokens instead.
ALTER TABLE identity.sessions ADD COLUMN web_secret_hash bytea;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE identity.sessions ADD CONSTRAINT sessions_web_secret_ck CHECK (
  (surface IN ('CUSTOMER_WEB','AGENT_WEB')) = (web_secret_hash IS NOT NULL)
  AND (web_secret_hash IS NULL OR octet_length(web_secret_hash) = 32));

-- 05 §2.3: 5 wrong PINs within 24 h lock the credential. The window start makes the count time-bounded.
ALTER TABLE identity.ivr_credentials ADD COLUMN failure_window_started_at timestamptz;

SELECT platform.classify('identity.subject_keys', 'I');
SELECT platform.classify('identity.sessions', 'I', 'web_secret_hash', 'R');
SELECT platform.classify('identity.ivr_credentials', 'I');
