// Every SQL statement of the backoffice module (own schema + the shared platform audit writer only).
export const SQL = {
  adminBySubject: 'SELECT id, status FROM backoffice.admin_users WHERE idp_subject = $1',
  adminById: 'SELECT id, status, idp_subject FROM backoffice.admin_users WHERE id = $1',
  /** Serialises logins per admin so the single-active-session rule holds under concurrent logins. */
  lockAdmin: 'SELECT id FROM backoffice.admin_users WHERE id = $1 FOR UPDATE',
  revokeAdminSessions: `UPDATE backoffice.admin_sessions SET revoked_at = $2, revoke_reason = $3
                         WHERE admin_user_id = $1 AND revoked_at IS NULL RETURNING id`,
  insertSession: `INSERT INTO backoffice.admin_sessions (id, admin_user_id, token_hash, auth_methods, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
  sessionForAuth: `SELECT s.id, s.admin_user_id, s.token_hash, s.idle_expires_at, s.absolute_expires_at, s.revoked_at, s.created_at,
                          u.status AS admin_status, u.idp_subject
                     FROM backoffice.admin_sessions s JOIN backoffice.admin_users u ON u.id = s.admin_user_id WHERE s.id = $1`,
  touchSession: 'UPDATE backoffice.admin_sessions SET last_seen_at = $2, idle_expires_at = least($3::timestamptz, absolute_expires_at) WHERE id = $1',
  revokeSession: 'UPDATE backoffice.admin_sessions SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL',
  authority: `SELECT rp.permission, g.scope_kind, g.city_ids
                FROM backoffice.admin_grants g JOIN backoffice.role_permissions rp ON rp.role_code = g.role_code
               WHERE g.admin_user_id = $1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > $2)`,

  credentialCount: 'SELECT count(*)::int AS n FROM backoffice.admin_webauthn_credentials WHERE admin_user_id = $1 AND revoked_at IS NULL',
  insertChallenge: `INSERT INTO backoffice.webauthn_challenges (id, admin_user_id, session_id, purpose, challenge_hash, action, resource_id,
                       payload_hash, expires_at, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  lockChallenge: `SELECT id, admin_user_id, session_id, purpose, challenge_hash, action, resource_id, payload_hash, expires_at, consumed_at,
                         verified_at, used_at
                    FROM backoffice.webauthn_challenges WHERE id = $1 FOR UPDATE`,
  markVerified: 'UPDATE backoffice.webauthn_challenges SET verified_at = $2 WHERE id = $1 AND verified_at IS NULL',
  markUsed: 'UPDATE backoffice.webauthn_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL',
  consumeChallenge: 'UPDATE backoffice.webauthn_challenges SET consumed_at = $2 WHERE id = $1',
  insertCredential: `INSERT INTO backoffice.admin_webauthn_credentials (id, admin_user_id, credential_id, public_key_spki, sign_count, backup_eligible, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  lockCredential: `SELECT id, public_key_spki, sign_count FROM backoffice.admin_webauthn_credentials
                    WHERE credential_id = $1 AND admin_user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
  updateCredential: 'UPDATE backoffice.admin_webauthn_credentials SET sign_count = $2, last_used_at = $3 WHERE id = $1',

  role: 'SELECT code, global_only FROM backoffice.roles WHERE code = $1',
  insertApproval: `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, resource_id, payload, payload_hash, risk_level,
                     requested_by_admin_id, requested_at, required_approver_permission, status, expires_at)
                   VALUES ($1, 'security.grant', 'backoffice.admin_user', $2, $3, $4, 'HIGH', $5, $6, 'security.grant.approve', 'PENDING', $7)`,
  lockApproval: `SELECT id, action_type, resource_id, payload, payload_hash, requested_by_admin_id, status, expires_at
                   FROM backoffice.approval_requests WHERE id = $1 FOR UPDATE`,
  approval: `SELECT id, action_type, resource_id, payload_hash, requested_by_admin_id, status, expires_at
               FROM backoffice.approval_requests WHERE id = $1`,
  decideApproval: `UPDATE backoffice.approval_requests SET status = $2, decided_by_admin_id = $3, decided_at = $4
                    WHERE id = $1 AND status = 'PENDING'`,
  markExecuted: "UPDATE backoffice.approval_requests SET status = 'EXECUTED' WHERE id = $1 AND status = 'APPROVED'",
  insertGrant: `INSERT INTO backoffice.admin_grants (id, admin_user_id, role_code, scope_kind, city_ids, granted_by_admin_id, approved_by_admin_id,
                  approval_request_id, expires_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
} as const;
