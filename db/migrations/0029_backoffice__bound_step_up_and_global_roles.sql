-- backoffice (Gate 3 review fixes):
-- 1. Action-bound step-up (SR-03, 05 §2.5): a verified WebAuthn assertion authorises exactly one server-validated
--    operation, once. For a grant decision it is bound to the approval request, its payload hash AND the decision
--    (APPROVE / REJECT). The session-wide `admin_sessions.step_up_at` is no longer written for admins.
-- 2. Passkey enrolment mode: every REGISTRATION challenge records whether it was issued under the first-passkey exemption
--    or after a bound step-up, so completion can refuse a stale first-passkey challenge once a passkey exists.
-- 3. Global-only roles (05 §5.3 scope column): SECURITY_ADMIN, FINANCE and AUDITOR can't be granted city-scoped.
--
-- Pre-existing data (explicit, never silent):
-- - webauthn_challenges: rows written before this migration can't satisfy the new binding. They are single-use 5-minute
--   nonces with no evidential value (the audit log records every ceremony separately). Rows that are expired or already
--   consumed are deleted (counted in a NOTICE). A live, unconsumed old row makes the migration FAIL with instructions
--   (re-run after it expires), so no in-flight ceremony is silently cut.
-- - admin_grants: an ACTIVE city-scoped grant of a global-only role makes the migration FAIL with the grant ids and the
--   remedy (revoke, then re-grant with GLOBAL scope through maker-checker). Grants are never deleted or rewritten.
--   Revoked or expired grants can authorise nothing and are kept as history.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

ALTER TABLE backoffice.webauthn_challenges ADD COLUMN resource_id uuid;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN payload_hash bytea;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN decision text;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN enrollment_mode text;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN verified_at timestamptz;
ALTER TABLE backoffice.webauthn_challenges ADD COLUMN used_at timestamptz;

ALTER TABLE backoffice.roles ADD COLUMN global_only boolean NOT NULL DEFAULT false;
UPDATE backoffice.roles SET global_only = true WHERE code IN ('SECURITY_ADMIN', 'FINANCE', 'AUDITOR');

DO $$
DECLARE
  v_grants text;
  v_deleted int;
  v_live int;
BEGIN
  SELECT string_agg(g.id::text || ' (' || g.role_code || ')', ', ' ORDER BY g.id) INTO v_grants
    FROM backoffice.admin_grants g JOIN backoffice.roles r ON r.code = g.role_code
   WHERE r.global_only AND g.scope_kind <> 'GLOBAL' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now());
  IF v_grants IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0029: active city-scoped grants of global-only roles exist: %', v_grants
      USING HINT = 'Revoke these grants (set revoked_at), then re-grant with GLOBAL scope through maker-checker, and re-run the migration. Nothing was changed.';
  END IF;

  -- Every row written before this migration is a legacy row (the new columns are all NULL).
  DELETE FROM backoffice.webauthn_challenges WHERE expires_at <= now() OR consumed_at IS NOT NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_live FROM backoffice.webauthn_challenges;
  IF v_live > 0 THEN
    RAISE EXCEPTION 'migration 0029: % unexpired, unconsumed WebAuthn challenge(s) from before this migration exist', v_live
      USING HINT = 'They expire within 5 minutes of issue. Re-run the migration after they expire (affected admins repeat the ceremony).';
  END IF;
  IF v_deleted > 0 THEN
    RAISE NOTICE 'migration 0029: deleted % expired or consumed pre-migration WebAuthn challenge row(s)', v_deleted;
  END IF;
END $$;

-- Every clause is written so that a NULL can't make it pass (a CHECK that evaluates to NULL is satisfied).
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE backoffice.webauthn_challenges ADD CONSTRAINT webauthn_step_up_binding_ck CHECK (
  (action IS NULL OR action IN ('security.grant.decide', 'backoffice.passkey.register'))
  AND (action IS DISTINCT FROM 'security.grant.decide'
       OR (resource_id IS NOT NULL AND payload_hash IS NOT NULL AND octet_length(payload_hash) = 32
           AND decision IS NOT NULL AND decision IN ('APPROVE', 'REJECT')))
  AND (action IS DISTINCT FROM 'backoffice.passkey.register' OR (resource_id IS NULL AND payload_hash IS NULL AND decision IS NULL))
  AND ((decision IS NULL) = (action IS DISTINCT FROM 'security.grant.decide'))
  AND ((purpose = 'REGISTRATION') = (enrollment_mode IS NOT NULL))
  AND (enrollment_mode IS NULL OR enrollment_mode IN ('FIRST_PASSKEY', 'STEP_UP'))
  AND (purpose = 'STEP_UP' OR (verified_at IS NULL AND used_at IS NULL))
  AND (used_at IS NULL OR verified_at IS NOT NULL)
  AND (verified_at IS NULL OR consumed_at IS NOT NULL));

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

SELECT platform.classify('backoffice.webauthn_challenges', 'I');
SELECT platform.classify('backoffice.roles', 'I');
