// Every SQL statement of the identity module (own schema + the shared platform audit writer only). Kept in one table
// so the B2 fitness test can check each statement's schema ownership.
export const SQL = {
  advisoryLockPhone: "SELECT pg_advisory_xact_lock(hashtextextended('identity.otp:' || encode($1::bytea, 'hex'), 0))",
  recentOtpCounts: `SELECT count(*) FILTER (WHERE created_at > $2::timestamptz - interval '30 seconds')::int AS last_30s,
                           count(*) FILTER (WHERE created_at > $2::timestamptz - interval '1 hour')::int AS last_hour,
                           count(*)::int AS last_day
                      FROM identity.otp_challenges WHERE phone_bidx = $1 AND created_at > $2::timestamptz - interval '1 day'`,
  insertOtp: `INSERT INTO identity.otp_challenges (id, phone_bidx, purpose, channel, code_hmac, max_attempts, expires_at, ip_hash, device_hash, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  lockOtp: `SELECT id, phone_bidx, purpose, code_hmac, attempts, max_attempts, expires_at, consumed_at
              FROM identity.otp_challenges WHERE id = $1 FOR UPDATE`,
  bumpOtpAttempt: 'UPDATE identity.otp_challenges SET attempts = attempts + 1, consumed_at = CASE WHEN $2 THEN $3::timestamptz ELSE consumed_at END WHERE id = $1',
  consumeOtp: 'UPDATE identity.otp_challenges SET consumed_at = $2 WHERE id = $1',

  userByBidx: 'SELECT id, status FROM identity.users WHERE phone_bidx = $1',
  userById: 'SELECT id, status, phone_bidx FROM identity.users WHERE id = $1',
  insertUser: `INSERT INTO identity.users (id, phone_enc, phone_bidx, phone_masked, preferred_locale, status)
               VALUES ($1, $2, $3, $4, $5, 'ACTIVE') ON CONFLICT (phone_bidx) WHERE phone_bidx IS NOT NULL DO NOTHING`,
  setPhoneEnc: 'UPDATE identity.users SET phone_enc = $2 WHERE id = $1',
  phoneEnc: 'SELECT phone_enc FROM identity.users WHERE id = $1',
  priorSessionCount: 'SELECT count(*)::int AS n FROM identity.sessions WHERE user_id = $1',

  subjectKey: 'SELECT wrapped_dek, kms_key_arn, destroyed_at FROM identity.subject_keys WHERE user_id = $1 AND data_class = $2',
  insertSubjectKey: `INSERT INTO identity.subject_keys (user_id, data_class, wrapped_dek, kms_key_arn) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (user_id, data_class) DO NOTHING`,

  deviceForUser: 'SELECT id, first_seen_at, revoked_at FROM identity.devices WHERE id = $1 AND user_id = $2',
  insertDevice: `INSERT INTO identity.devices (id, user_id, platform, app_version, integrity_verdict, first_seen_at, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
  touchDevice: 'UPDATE identity.devices SET last_seen_at = $2, app_version = coalesce($3, app_version) WHERE id = $1',

  insertSession: `INSERT INTO identity.sessions (id, user_id, device_id, surface, auth_methods, idle_expires_at, absolute_expires_at, web_secret_hash, created_at, last_seen_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
  sessionForAuth: `SELECT s.id, s.user_id, s.device_id, s.surface, s.auth_methods, s.step_up_at, s.idle_expires_at, s.absolute_expires_at,
                          s.revoked_at, s.web_secret_hash, u.status AS user_status, d.revoked_at AS device_revoked_at
                     FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id
                     LEFT JOIN identity.devices d ON d.id = s.device_id
                    WHERE s.id = $1`,
  touchSession: 'UPDATE identity.sessions SET last_seen_at = $2, idle_expires_at = least($3::timestamptz, absolute_expires_at) WHERE id = $1 AND revoked_at IS NULL',
  setStepUp: 'UPDATE identity.sessions SET step_up_at = $2 WHERE id = $1 AND revoked_at IS NULL',
  revokeSession: `UPDATE identity.sessions SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL`,
  revokeUserSessions: `UPDATE identity.sessions SET revoked_at = $2, revoke_reason = $3 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
  listSessions: `SELECT id, surface, created_at, last_seen_at FROM identity.sessions
                  WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > $2 ORDER BY created_at DESC LIMIT 50`,
  sessionOwner: 'SELECT user_id FROM identity.sessions WHERE id = $1 AND revoked_at IS NULL',

  insertRefresh: `INSERT INTO identity.refresh_tokens (id, session_id, family_id, token_hash, issued_at, expires_at)
                  VALUES ($1, $2, $3, $4, $5, $6)`,
  lockRefresh: `SELECT r.id, r.session_id, r.family_id, r.expires_at, r.used_at, r.replaced_by_id, r.revoked_at,
                       s.device_id, s.user_id, s.revoked_at AS session_revoked_at, s.absolute_expires_at
                  FROM identity.refresh_tokens r JOIN identity.sessions s ON s.id = r.session_id
                 WHERE r.token_hash = $1 FOR UPDATE OF r`,
  markRefreshUsed: 'UPDATE identity.refresh_tokens SET used_at = $2, replaced_by_id = $3 WHERE id = $1',
  revokeFamily: 'UPDATE identity.refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
  revokeSessionTokens: 'UPDATE identity.refresh_tokens SET revoked_at = $2 WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL',

  pinCredential: `SELECT pin_hash, failed_attempts, failure_window_started_at, (locked_until IS NOT NULL AND locked_until > $2) AS locked
                    FROM identity.ivr_credentials WHERE user_id = $1 FOR UPDATE`,
  upsertPin: `INSERT INTO identity.ivr_credentials (user_id, pin_hash, failed_attempts, locked_until, last_changed_at, set_via, failure_window_started_at)
              VALUES ($1, $2, 0, NULL, $3, $4, NULL)
              ON CONFLICT (user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL,
                last_changed_at = EXCLUDED.last_changed_at, set_via = EXCLUDED.set_via, failure_window_started_at = NULL,
                version = identity.ivr_credentials.version + 1`,
  pinHash: 'SELECT pin_hash FROM identity.ivr_credentials WHERE user_id = $1',
  pinFailure: `UPDATE identity.ivr_credentials SET failed_attempts = $2, failure_window_started_at = $3,
                 locked_until = CASE WHEN $4 THEN 'infinity'::timestamptz ELSE locked_until END WHERE user_id = $1`,
  pinSuccess: 'UPDATE identity.ivr_credentials SET failed_attempts = 0, failure_window_started_at = NULL, pin_hash = coalesce($2, pin_hash) WHERE user_id = $1',

  eraseUser: `UPDATE identity.users SET status = 'ERASED', phone_enc = NULL, phone_bidx = NULL, phone_masked = NULL, erased_at = $2
               WHERE id = $1 AND status <> 'ERASED'`,
  destroySubjectKeys: 'UPDATE identity.subject_keys SET wrapped_dek = NULL, destroyed_at = $2 WHERE user_id = $1 AND destroyed_at IS NULL',
  revokeUserDevices: 'UPDATE identity.devices SET revoked_at = coalesce(revoked_at, $2), push_token_enc = NULL WHERE user_id = $1',
  deleteIvrCredential: 'DELETE FROM identity.ivr_credentials WHERE user_id = $1',
  suspendUser: `UPDATE identity.users SET status = 'SUSPENDED', suspended_reason_code = $2 WHERE id = $1 AND status = 'ACTIVE'`,
} as const;
