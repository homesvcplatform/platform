-- backoffice (Gate 3 review fixes):
-- 1. Action-bound step-up (SR-03, 05 §2.5): a verified WebAuthn assertion authorises exactly one server-validated
--    operation. For a grant decision it is bound to the approval request and its payload hash, and is used at most once.
--    The session-wide `admin_sessions.step_up_at` is no longer written for admins.
-- 2. Global-only roles (05 §5.3 scope column): roles whose scope is "global" (security admin, finance, auditor) can't be
--    granted city-scoped, so a city grant can never carry security administration.
-- The altered tables are empty in every environment except `roles` (10 seeded rows), so the lock rules waived below have
-- nothing meaningful to lock.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE backoffice.webauthn_challenges ADD COLUMN resource_id uuid;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN payload_hash bytea;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN verified_at timestamptz;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN used_at timestamptz;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE backoffice.webauthn_challenges ADD CONSTRAINT webauthn_step_up_binding_ck CHECK (
  (action IS NULL OR action IN ('security.grant.decide', 'backoffice.passkey.register'))
  AND (action IS DISTINCT FROM 'security.grant.decide' OR (resource_id IS NOT NULL AND octet_length(payload_hash) = 32))
  AND (action IS DISTINCT FROM 'backoffice.passkey.register' OR (resource_id IS NULL AND payload_hash IS NULL))
  AND (used_at IS NULL OR verified_at IS NOT NULL)
  AND (verified_at IS NULL OR consumed_at IS NOT NULL));

ALTER TABLE backoffice.roles ADD COLUMN global_only boolean NOT NULL DEFAULT false;
UPDATE backoffice.roles SET global_only = true WHERE code IN ('SECURITY_ADMIN', 'FINANCE', 'AUDITOR');

CREATE FUNCTION backoffice.guard_grant_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.scope_kind <> 'GLOBAL' AND EXISTS (SELECT 1 FROM backoffice.roles r WHERE r.code = NEW.role_code AND r.global_only) THEN
    RAISE EXCEPTION 'role % can only be granted with GLOBAL scope', NEW.role_code USING ERRCODE = 'HS020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_grant_scope BEFORE INSERT OR UPDATE OF role_code, scope_kind ON backoffice.admin_grants
  FOR EACH ROW EXECUTE FUNCTION backoffice.guard_grant_scope();
REVOKE ALL ON FUNCTION backoffice.guard_grant_scope() FROM PUBLIC;

SELECT platform.classify('backoffice.webauthn_challenges', 'I', 'payload_hash', 'I');
SELECT platform.classify('backoffice.roles', 'I');
