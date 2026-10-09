-- backoffice (Gate 4, ADR-025 #5–#6): two-person approved configuration changes ("change requests") reuse
-- approval_requests. The checker's passkey step-up is bound to the change request, its payload hash and the decision,
-- through a new step-up operation with exactly the binding rules of a grant decision (Gate 3, migration 0029).
-- Locale enablement gets code-defined permissions (proposed default for founder acceptance, ADR-025 #6):
-- PRICING_ADMIN proposes (locales.enable), CITY_MANAGER approves (locales.approve), city-scoped like service rules.
--
-- Pre-existing data: every existing challenge row satisfies the new CHECK (its allowlist is a superset of 0029's and
-- the existing operations keep their rules), so no row is changed or removed.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE backoffice.webauthn_challenges DROP CONSTRAINT webauthn_step_up_binding_ck;

-- Every clause is written so that a NULL can't make it pass (a CHECK that evaluates to NULL is satisfied).
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE backoffice.webauthn_challenges ADD CONSTRAINT webauthn_step_up_binding_ck CHECK (
  (action IS NULL OR action IN ('security.grant.decide', 'backoffice.change.decide', 'backoffice.passkey.register'))
  AND (action IS NULL OR action NOT IN ('security.grant.decide', 'backoffice.change.decide')
       OR (resource_id IS NOT NULL AND payload_hash IS NOT NULL AND octet_length(payload_hash) = 32
           AND decision IS NOT NULL AND decision IN ('APPROVE', 'REJECT')))
  AND (action IS DISTINCT FROM 'backoffice.passkey.register' OR (resource_id IS NULL AND payload_hash IS NULL AND decision IS NULL))
  AND ((decision IS NULL) = (action IS NULL OR action NOT IN ('security.grant.decide', 'backoffice.change.decide')))
  AND ((purpose = 'REGISTRATION') = (enrollment_mode IS NOT NULL))
  AND (enrollment_mode IS NULL OR enrollment_mode IN ('FIRST_PASSKEY', 'STEP_UP'))
  AND (purpose = 'STEP_UP' OR (verified_at IS NULL AND used_at IS NULL))
  AND (used_at IS NULL OR verified_at IS NOT NULL)
  AND (verified_at IS NULL OR consumed_at IS NOT NULL));

INSERT INTO backoffice.role_permissions (role_code, permission) VALUES
  ('PRICING_ADMIN', 'locales.enable'),
  ('CITY_MANAGER', 'locales.approve');
