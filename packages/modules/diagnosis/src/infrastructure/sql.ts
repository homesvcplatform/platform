// SQL of module "diagnosis" (schema diagnosis + shared platform only, B2). Status changes run under the transaction-local
// actor context (quote-version history, migration 0037); the database refuses edits of submitted diagnoses, presented
// versions and their items (INV-05), decisions on anything but the PRESENTED version with its hash (INV-06), and a
// second APPROVED version (INV-07).

const DIAGNOSIS_COLUMNS = `id, job_id, visit_id, technician_user_id, captured_by_actor_type, captured_by_actor_id, kind, problem_code, observed_chips,
  severity, safety_advice_code, required_repair_service_type_id, required_repair_specialization_id, no_repair_needed, same_visit_feasible,
  material_available_now, status, supersedes_id, submitted_at, draft_lines, version`;

const VERSION_COLUMNS = `v.id, v.quote_id, v.version_no, v.diagnosis_ids, v.created_by_actor_type, v.price_snapshot_id, v.items_total_paise, v.discount_paise,
  v.visit_fee_credit_paise, v.tax_paise, v.total_payable_paise, v.technician_earnings_paise, v.content_hash, v.status, v.presented_at, v.expires_at,
  v.decided_at, v.supersedes_version_id, q.job_id, q.approved_version_id`;

export const SQL = {
  actorContext: `SELECT set_config('hsp.actor_type', $1, true), set_config('hsp.actor_id', $2, true), set_config('hsp.channel', $3, true),
                        set_config('hsp.correlation_id', $4, true), set_config('hsp.reason_code', $5, true)`,
  completedIdempotency: `SELECT response_status FROM platform.idempotency_keys WHERE actor_key = $1 AND idem_key = $2 AND status = 'COMPLETED'`,
  outbox: `
    INSERT INTO platform.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id, city_id, occurred_at)
    VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,

  // diagnoses
  openDraft: `SELECT id, version FROM diagnosis.diagnoses WHERE visit_id = $1 AND kind = $2 AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`,
  insertDiagnosis: `
    INSERT INTO diagnosis.diagnoses (id, job_id, visit_id, technician_user_id, captured_by_actor_type, captured_by_actor_id, kind, problem_code, severity,
      same_visit_feasible, material_available_now, status, draft_lines, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNSET', 'MINOR', false, false, 'DRAFT', '[]', $8, $8)`,
  diagnosis: `SELECT ${DIAGNOSIS_COLUMNS} FROM diagnosis.diagnoses WHERE id = $1`,
  lockDiagnosis: `SELECT ${DIAGNOSIS_COLUMNS} FROM diagnosis.diagnoses WHERE id = $1 FOR UPDATE`,
  updateDraft: `
    UPDATE diagnosis.diagnoses SET problem_code = $3, observed_chips = $4, severity = $5, safety_advice_code = $6, no_repair_needed = $7,
           same_visit_feasible = $8, material_available_now = $9, draft_lines = $10, required_repair_service_type_id = $11,
           required_repair_specialization_id = $12, updated_at = $13, version = version + 1
     WHERE id = $1 AND version = $2 AND status = 'DRAFT'
    RETURNING version`,
  insertDiagnosisItem: `
    INSERT INTO diagnosis.diagnosis_items (id, diagnosis_id, line_type, repair_item_id, material_id, qty, proposed_unit_price_paise, reason_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  submitDiagnosis: `
    UPDATE diagnosis.diagnoses SET status = 'SUBMITTED', submitted_at = $2, supersedes_id = $3, draft_lines = NULL, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'DRAFT'`,
  supersedeDiagnosis: `UPDATE diagnosis.diagnoses SET status = 'SUPERSEDED', updated_at = $2, version = version + 1 WHERE id = $1 AND status = 'SUBMITTED'`,
  submittedInitialOfJob: `
    SELECT id FROM diagnosis.diagnoses WHERE job_id = $1 AND kind = 'INITIAL' AND status = 'SUBMITTED' AND id <> $2 ORDER BY submitted_at DESC`,
  diagnosisLines: `
    SELECT i.diagnosis_id, i.line_type, i.repair_item_id, i.material_id, i.qty, i.proposed_unit_price_paise, i.reason_code
      FROM diagnosis.diagnosis_items i WHERE i.diagnosis_id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], i.diagnosis_id), i.id`,
  initialDiagnosisOf: `
    SELECT ${DIAGNOSIS_COLUMNS} FROM diagnosis.diagnoses WHERE id = ANY($1::uuid[]) AND kind = 'INITIAL' ORDER BY submitted_at LIMIT 1`,
  checkoutFacts: `
    SELECT d.id, d.no_repair_needed,
           EXISTS (SELECT 1 FROM diagnosis.quote_versions v
                    WHERE d.id = ANY (v.diagnosis_ids) AND v.presented_at IS NOT NULL AND v.status <> 'WITHDRAWN') AS presented
      FROM diagnosis.diagnoses d WHERE d.visit_id = $1 AND d.kind = 'INITIAL' AND d.status = 'SUBMITTED'
     ORDER BY d.submitted_at DESC LIMIT 1`,

  // quotes and versions
  ensureQuote: `INSERT INTO diagnosis.quotes (id, job_id) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING`,
  quoteOfJob: `SELECT id, latest_version_no, approved_version_id, version FROM diagnosis.quotes WHERE job_id = $1`,
  lockQuoteOfJob: `SELECT id, latest_version_no, approved_version_id, version FROM diagnosis.quotes WHERE job_id = $1 FOR UPDATE`,
  lockQuote: `SELECT id, job_id, latest_version_no, approved_version_id, version FROM diagnosis.quotes WHERE id = $1 FOR UPDATE`,
  setLatestVersionNo: `UPDATE diagnosis.quotes SET latest_version_no = $2, version = version + 1 WHERE id = $1`,
  setApprovedVersion: `UPDATE diagnosis.quotes SET approved_version_id = $2, version = version + 1 WHERE id = $1`,
  insertVersion: `
    INSERT INTO diagnosis.quote_versions (id, quote_id, version_no, diagnosis_ids, created_by_actor_type, created_by_actor_id, price_snapshot_id,
      items_total_paise, discount_paise, visit_fee_credit_paise, tax_paise, total_payable_paise, technician_earnings_paise, content_hash, status,
      supersedes_version_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'DRAFT', $15, $16)`,
  insertQuoteItem: `
    INSERT INTO diagnosis.quote_items (id, quote_version_id, line_no, item_type, repair_item_id, material_id, label_key, label_params, qty,
      unit_price_paise, amount_paise, reference_unit_price_paise, deviation_bps, deviation_reason_code, tax_rate_bps, technician_share_paise)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
  presentVersion: `UPDATE diagnosis.quote_versions SET status = 'PRESENTED', presented_at = $2, expires_at = $3 WHERE id = $1 AND status = 'DRAFT'`,
  withdrawPresented: `UPDATE diagnosis.quote_versions SET status = 'WITHDRAWN' WHERE quote_id = $1 AND status = 'PRESENTED' RETURNING id`,
  version: `SELECT ${VERSION_COLUMNS} FROM diagnosis.quote_versions v JOIN diagnosis.quotes q ON q.id = v.quote_id WHERE v.id = $1`,
  lockVersion: `SELECT ${VERSION_COLUMNS} FROM diagnosis.quote_versions v JOIN diagnosis.quotes q ON q.id = v.quote_id WHERE v.id = $1 FOR UPDATE OF v`,
  versionsOfJob: `
    SELECT ${VERSION_COLUMNS} FROM diagnosis.quote_versions v JOIN diagnosis.quotes q ON q.id = v.quote_id
     WHERE q.job_id = $1 AND v.status <> 'DRAFT' ORDER BY v.version_no DESC`,
  presentedOfQuote: `SELECT id FROM diagnosis.quote_versions WHERE quote_id = $1 AND status = 'PRESENTED'`,
  quoteItems: `
    SELECT id, line_no, item_type, repair_item_id, material_id, label_key, label_params, qty, unit_price_paise, amount_paise,
           reference_unit_price_paise, deviation_bps
      FROM diagnosis.quote_items WHERE quote_version_id = $1 ORDER BY line_no`,
  decideVersion: `UPDATE diagnosis.quote_versions SET status = $2, decided_at = $3 WHERE id = $1 AND status = 'PRESENTED'`,
  supersedeVersion: `UPDATE diagnosis.quote_versions SET status = 'SUPERSEDED' WHERE id = $1 AND status = 'APPROVED'`,
  expireVersion: `UPDATE diagnosis.quote_versions SET status = 'EXPIRED', decided_at = $2 WHERE id = $1 AND status = 'PRESENTED'`,
  overdueVersions: `SELECT id FROM diagnosis.quote_versions WHERE status = 'PRESENTED' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`,

  // decisions
  insertDecision: `
    INSERT INTO diagnosis.quote_approvals (id, quote_version_id, decision, content_hash, channel, customer_user_id, session_id, device_id,
      otp_challenge_id, call_session_id, ops_recorder_admin_id, ops_verifier_admin_id, diagnosis_capturer_admin_id, repair_preference,
      preferred_technician_user_id, allow_fallback, preferred_window, rejection_reason_code, decided_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            CASE WHEN $17::timestamptz IS NULL THEN NULL ELSE tstzrange($17::timestamptz, $18::timestamptz) END, $19, $20)`,
  decisionOf: `
    SELECT decision, channel, repair_preference, preferred_technician_user_id, allow_fallback, lower(preferred_window) AS window_start,
           upper(preferred_window) AS window_end, decided_at
      FROM diagnosis.quote_approvals WHERE quote_version_id = $1`,

  // signed links (SR-05)
  insertLink: `INSERT INTO diagnosis.quote_links (id, quote_version_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
  linkByHash: `
    SELECT l.id, l.quote_version_id, l.expires_at, l.used_at, q.job_id
      FROM diagnosis.quote_links l JOIN diagnosis.quote_versions v ON v.id = l.quote_version_id JOIN diagnosis.quotes q ON q.id = v.quote_id
     WHERE l.token_hash = $1`,
  useLink: `UPDATE diagnosis.quote_links SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2`,

  // TCP-2 (material usage at repair completion, in the jobs transaction)
  lockQuoteOfVersion: `
    SELECT q.id, q.approved_version_id FROM diagnosis.quotes q JOIN diagnosis.quote_versions v ON v.quote_id = q.id WHERE v.id = $1 FOR UPDATE OF q`,
  materialItems: `SELECT id, material_id, qty FROM diagnosis.quote_items WHERE quote_version_id = $1 AND item_type = 'MATERIAL' ORDER BY line_no`,
  insertUsage: `
    INSERT INTO diagnosis.material_usage (id, repair_order_id, visit_id, quote_item_id, material_id, qty_quoted, qty_used, actual_unit_cost_paise,
      recorded_by_actor_type, recorded_by_actor_id, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
} as const;
