-- catalog: category -> service type -> specialization -> repair item tree, symptoms, materials, service rules.
-- Phase 1 03 §8 / §8.1 and ADR-020: what a city offers is data (service_rules.rules.enabled), not code.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA catalog;

CREATE TABLE catalog.service_categories (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  names      jsonb NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  status     text NOT NULL CHECK (status IN ('ACTIVE','HIDDEN','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.service_types (
  id          uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES catalog.service_categories(id),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  names       jsonb NOT NULL,
  icon_ref    text,
  status      text NOT NULL CHECK (status IN ('ACTIVE','HIDDEN','RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_types_category_ix ON catalog.service_types (category_id);

-- Specializations are per service type: COOLING under REFRIGERATOR is a different row from COOLING under AC.
CREATE TABLE catalog.specializations (
  id              uuid PRIMARY KEY,
  service_type_id uuid NOT NULL REFERENCES catalog.service_types(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  names           jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_type_id, code)
);

CREATE TABLE catalog.symptoms (
  id              uuid PRIMARY KEY,
  service_type_id uuid NOT NULL REFERENCES catalog.service_types(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  names           jsonb NOT NULL,
  sort_order      smallint NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_type_id, code)
);

CREATE TABLE catalog.repair_items (
  id                         uuid PRIMARY KEY,
  service_type_id            uuid NOT NULL REFERENCES catalog.service_types(id),
  code                       text NOT NULL UNIQUE CHECK (code ~ '^REP-[A-Z0-9-]{3,60}$'),
  keypad_code                text CHECK (keypad_code ~ '^[0-9]{2,3}$'),
  names                      jsonb NOT NULL,
  required_service_type_id   uuid NOT NULL REFERENCES catalog.service_types(id),
  required_specialization_id uuid REFERENCES catalog.specializations(id),
  warranty_policy_code       text,
  status                     text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_type_id, keypad_code)   -- IVR keypad codes are service-type-specific (ADR-020)
);

CREATE TABLE catalog.materials (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE CHECK (code ~ '^MAT-[A-Z0-9-]{3,60}$'),
  names      jsonb NOT NULL,
  unit       text NOT NULL CHECK (unit IN ('PIECE','METRE','LITRE','KG','SET')),
  status     text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.material_reference_prices (
  id               uuid PRIMARY KEY,
  material_id      uuid NOT NULL REFERENCES catalog.materials(id),
  city_id          uuid NOT NULL,   -- ref: geo.cities
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  effective        tstzrange NOT NULL CHECK (NOT isempty(effective)),
  source           text NOT NULL,
  EXCLUDE USING gist (material_id WITH =, city_id WITH =, effective WITH &&)
);

-- Effective-dated, maker-checker. rules is JSON-schema validated by the catalog module (same_visit_repair_allowed,
-- min_verification_level, quote_expiry_hours, enabled (city-scoped bookability, ADR-020), ...).
CREATE TABLE catalog.service_rules (
  id                  uuid PRIMARY KEY,
  service_type_id     uuid NOT NULL REFERENCES catalog.service_types(id),
  city_id             uuid,   -- ref: geo.cities; NULL = default for all cities
  rules               jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  effective           tstzrange NOT NULL CHECK (NOT isempty(effective)),
  status              text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED')),
  approval_request_id uuid,   -- ref: backoffice.approval_requests
  created_at          timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (service_type_id WITH =,
                      (coalesce(city_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
                      effective WITH &&) WHERE (status = 'ACTIVE')
);

SELECT platform.track_updates('catalog.service_categories');
SELECT platform.track_updates('catalog.service_types');
SELECT platform.track_updates('catalog.repair_items');

SELECT platform.classify('catalog.service_categories', 'I', 'names', 'P');
SELECT platform.classify('catalog.service_types', 'I', 'names', 'P');
SELECT platform.classify('catalog.specializations', 'I', 'names', 'P');
SELECT platform.classify('catalog.symptoms', 'I', 'names', 'P');
SELECT platform.classify('catalog.repair_items', 'I', 'names', 'P');
SELECT platform.classify('catalog.materials', 'I', 'names', 'P');
SELECT platform.classify('catalog.material_reference_prices', 'I');
SELECT platform.classify('catalog.service_rules', 'I');

GRANT USAGE ON SCHEMA catalog TO app_api, app_admin, app_worker;
GRANT SELECT ON catalog.service_categories, catalog.service_types, catalog.specializations, catalog.symptoms,
      catalog.repair_items, catalog.materials, catalog.material_reference_prices, catalog.service_rules TO app_api;
GRANT SELECT, INSERT, UPDATE ON catalog.service_categories, catalog.service_types, catalog.specializations, catalog.symptoms,
      catalog.repair_items, catalog.materials, catalog.material_reference_prices, catalog.service_rules TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.service_categories, catalog.service_types, catalog.specializations, catalog.symptoms,
      catalog.repair_items, catalog.materials, catalog.material_reference_prices, catalog.service_rules TO app_worker;
