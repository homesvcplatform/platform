-- pricing (Gate 6, ADR-027 #4, errata G-8, D-07 "configurable only"): the share of the visit fee credited back on a
-- quote becomes a fee rule of the rate card (`VISIT_FEE_CREDIT`, params `credit_bps`), so pricing Models B (0 %) and
-- C (50 %) differ only in data. Values are fixtures, NOT FINAL. No other fee type changes.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE pricing.fee_rules DROP CONSTRAINT fee_rules_fee_type_check;
-- The table holds only fixture configuration (no production rows exist); the new list is a superset of the old one.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE pricing.fee_rules ADD CONSTRAINT fee_rules_fee_type_check CHECK (fee_type IN ('PLATFORM_FEE','MATERIAL_MARKUP','CANCELLATION',
  'WAITING','TRAVEL_COMPENSATION','NO_SHOW','DIAGNOSIS_PAYOUT','VISIT_FEE_CREDIT'));
