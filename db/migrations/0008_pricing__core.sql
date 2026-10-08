-- pricing: versioned rate cards, fee rules, tax rules (inactive until CA sign-off), immutable price snapshots.
-- Phase 1 03 §8, INV-21, errata X-10 (api may insert snapshots). No final values in migrations (Phase 2 01 §7).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA pricing;

CREATE TABLE pricing.rate_cards (
  id                  uuid PRIMARY KEY,
  city_id             uuid NOT NULL,   -- ref: geo.cities
  version_no          int NOT NULL CHECK (version_no >= 1),
  label               text NOT NULL CHECK (char_length(label) BETWEEN 3 AND 80),
  status              text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','ACTIVE','RETIRED')),
  effective           tstzrange,       -- set on approval
  created_by_admin_id uuid NOT NULL,
  approval_request_id uuid,            -- ref: backoffice.approval_requests
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, version_no),
  CHECK (status NOT IN ('APPROVED','ACTIVE') OR (effective IS NOT NULL AND NOT isempty(effective) AND approval_request_id IS NOT NULL)),
  EXCLUDE USING gist (city_id WITH =, effective WITH &&) WHERE (status IN ('APPROVED','ACTIVE'))
);

CREATE TABLE pricing.rate_card_items (
  id                   uuid PRIMARY KEY,
  rate_card_id         uuid NOT NULL REFERENCES pricing.rate_cards(id),
  target_type          text NOT NULL CHECK (target_type IN ('VISIT_FEE','REPAIR_ITEM')),
  service_type_id      uuid,   -- ref: catalog.service_types
  repair_item_id       uuid,   -- ref: catalog.repair_items
  labour_paise         bigint NOT NULL CHECK (labour_paise >= 0),
  min_paise            bigint NOT NULL CHECK (min_paise >= 0),
  max_paise            bigint NOT NULL,
  technician_share_bps int NOT NULL CHECK (technician_share_bps BETWEEN 0 AND 10000),
  CHECK (min_paise <= labour_paise AND labour_paise <= max_paise),
  CHECK ((target_type = 'VISIT_FEE' AND service_type_id IS NOT NULL AND repair_item_id IS NULL)
      OR (target_type = 'REPAIR_ITEM' AND repair_item_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (rate_card_id, target_type, service_type_id, repair_item_id)
);

CREATE TABLE pricing.fee_rules (
  id           uuid PRIMARY KEY,
  rate_card_id uuid NOT NULL REFERENCES pricing.rate_cards(id),
  fee_type     text NOT NULL CHECK (fee_type IN ('PLATFORM_FEE','MATERIAL_MARKUP','CANCELLATION','WAITING','TRAVEL_COMPENSATION','NO_SHOW','DIAGNOSIS_PAYOUT')),
  params       jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  applies_to   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(applies_to) = 'object')
);
CREATE INDEX fee_rules_card_ix ON pricing.fee_rules (rate_card_id);

-- Values require CA sign-off before use; no tax lines are active in Phase 2.
CREATE TABLE pricing.tax_rules (
  id                  uuid PRIMARY KEY,
  code                text NOT NULL,
  applies_to          text NOT NULL,
  rate_bps            int NOT NULL CHECK (rate_bps BETWEEN 0 AND 5000),
  liable_party        text NOT NULL CHECK (liable_party IN ('PLATFORM','TECHNICIAN','NONE')),
  effective           tstzrange NOT NULL CHECK (NOT isempty(effective)),
  approval_request_id uuid NOT NULL    -- ref: backoffice.approval_requests
);

-- Immutable (INV-21): later rate-card changes never alter a snapshot.
CREATE TABLE pricing.price_snapshots (
  id             uuid PRIMARY KEY,
  rate_card_id   uuid NOT NULL REFERENCES pricing.rate_cards(id),
  rule_refs      jsonb NOT NULL,
  inputs         jsonb NOT NULL,
  outputs        jsonb NOT NULL,
  engine_version text NOT NULL,
  content_hash   bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_at     timestamptz NOT NULL DEFAULT now()
);

SELECT platform.make_append_only('pricing.price_snapshots');

SELECT platform.classify('pricing.rate_cards', 'I');
SELECT platform.classify('pricing.rate_card_items', 'I');
SELECT platform.classify('pricing.fee_rules', 'I');
SELECT platform.classify('pricing.tax_rules', 'I');
SELECT platform.classify('pricing.price_snapshots', 'I');

GRANT USAGE ON SCHEMA pricing TO app_api, app_admin, app_worker;
GRANT SELECT ON pricing.rate_cards, pricing.rate_card_items, pricing.fee_rules, pricing.tax_rules TO app_api;
GRANT SELECT, INSERT ON pricing.price_snapshots TO app_api, app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON pricing.rate_cards, pricing.rate_card_items, pricing.fee_rules, pricing.tax_rules TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON pricing.rate_cards, pricing.rate_card_items, pricing.fee_rules, pricing.tax_rules TO app_worker;
