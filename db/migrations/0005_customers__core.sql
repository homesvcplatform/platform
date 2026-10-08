-- customers: profiles, address book, restricted segment attributes. Phase 1 03 §5, founder answer Q-C.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA customers;

CREATE TABLE customers.customer_profiles (
  user_id            uuid PRIMARY KEY,   -- ref: identity.users
  display_name_enc   bytea,
  preferred_locale   text NOT NULL CHECK (preferred_locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  -- Q-C: optional; communication, support, booking assistance and language-friction metrics only.
  -- Never used for profiling or technician ranking.
  preferred_language text CHECK (preferred_language IN ('te','en','other')),
  marketing_opt_in   boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 0
);

CREATE TABLE customers.addresses (
  id               uuid PRIMARY KEY,
  customer_user_id uuid NOT NULL,   -- ref: identity.users
  city_id          uuid NOT NULL,   -- ref: geo.cities
  locality_id      uuid NOT NULL,   -- ref: geo.localities
  label            text CHECK (char_length(label) <= 30),
  line1_enc        bytea NOT NULL,
  line2_enc        bytea,
  landmark_enc     bytea NOT NULL,
  access_notes_enc bytea,
  point_exact_enc  bytea,
  point_coarse     geography(Point, 4326),
  digipin_enc      bytea,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 0
);
CREATE INDEX addresses_customer_ix ON customers.addresses (customer_user_id) WHERE deleted_at IS NULL;

-- Restricted: segment statistics only (consent SEGMENT_STATISTICS). Readable only by the trust aggregation job (worker).
CREATE TABLE customers.customer_sensitive_attributes (
  user_id          uuid PRIMARY KEY,   -- ref: identity.users
  gender_enc       bytea NOT NULL,
  consent_event_id uuid NOT NULL,      -- ref: compliance.consent_events
  created_at       timestamptz NOT NULL DEFAULT now()
);

SELECT platform.track_updates('customers.customer_profiles');
SELECT platform.track_updates('customers.addresses');

SELECT platform.classify('customers.customer_profiles', 'I', 'display_name_enc', 'C,enc');
SELECT platform.classify('customers.addresses', 'I',
  'line1_enc', 'C,enc', 'line2_enc', 'C,enc', 'landmark_enc', 'C,enc', 'access_notes_enc', 'C,enc',
  'point_exact_enc', 'C,enc', 'digipin_enc', 'C,enc');
SELECT platform.classify('customers.customer_sensitive_attributes', 'R', 'gender_enc', 'R,enc', 'user_id', 'I', 'created_at', 'I');

SELECT platform.register_encrypted('customers.customer_profiles', 'display_name_enc', 'CUSTOMER', 'user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'line1_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'line2_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'landmark_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'access_notes_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'point_exact_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.addresses', 'digipin_enc', 'CUSTOMER', 'customer_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');
SELECT platform.register_encrypted('customers.customer_sensitive_attributes', 'gender_enc', 'CUSTOMER', 'user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');

GRANT USAGE ON SCHEMA customers TO app_api, app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON customers.customer_profiles, customers.addresses TO app_api;
GRANT INSERT ON customers.customer_sensitive_attributes TO app_api;   -- write-only for the API
GRANT SELECT, UPDATE ON customers.customer_profiles TO app_admin;
GRANT SELECT ON customers.addresses TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers.customer_profiles, customers.addresses, customers.customer_sensitive_attributes TO app_worker;
