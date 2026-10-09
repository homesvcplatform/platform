// SQL of module "jobs" (schema jobs + shared platform only, B2). Status changes run under the transaction-local actor
// context (migration 0033); the database refuses anything the transition tables don't allow.

export const SQL = {
  actorContext: `SELECT set_config('hsp.actor_type', $1, true), set_config('hsp.actor_id', $2, true), set_config('hsp.channel', $3, true),
                        set_config('hsp.correlation_id', $4, true), set_config('hsp.reason_code', $5, true)`,
  reasonContext: `SELECT set_config('hsp.reason_code', $1, true)`,
  bookingLock: `SELECT pg_advisory_xact_lock(hashtextextended('jobs.booking:' || $1, 0))`,
  technicianLock: `SELECT pg_advisory_xact_lock(hashtextextended('jobs.technician:' || $1, 0))`,

  jobByClientRequest: `SELECT id FROM jobs.jobs WHERE customer_user_id = $1 AND client_request_id = $2`,
  possibleDuplicate: `
    SELECT id FROM jobs.jobs
     WHERE customer_user_id = $1 AND address_id = $2 AND service_type_id = $3
       AND status IN ('REQUESTED','IN_DIAGNOSIS','AWAITING_APPROVAL','REPAIR_PENDING','REPAIR_IN_PROGRESS')
     ORDER BY created_at DESC LIMIT 1`,
  insertJob: `
    INSERT INTO jobs.jobs (id, public_ref, customer_user_id, city_id, zone_id, locality_id, service_type_id, symptom_codes, address_id,
      address_snapshot_enc, channel, payment_preference, onsite_adult, created_by_actor_type, created_by_actor_id, customer_verified,
      client_request_id, status, visit_fee_snapshot_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'REQUESTED', $18, $19, $19)`,
  insertVisit: `
    INSERT INTO jobs.visits (id, job_id, city_id, locality_id, sequence_no, purposes, required_service_type_id, required_capability,
      service_window, urgency, status, start_code_hash, visit_code, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 1, '{DIAGNOSIS}', $5, 'DIAGNOSE', tstzrange($6, $7), $8, 'PLANNED', $9, $10, $11, $11)`,

  job: `SELECT id, public_ref, customer_user_id, city_id, locality_id, service_type_id, status, customer_verified, needs_attention, visit_fee_snapshot_id,
               version, created_at FROM jobs.jobs WHERE id = $1`,
  lockJob: `SELECT id, public_ref, customer_user_id, city_id, locality_id, service_type_id, status, customer_verified, visit_fee_snapshot_id, version
              FROM jobs.jobs WHERE id = $1 FOR UPDATE`,
  setJobStatus: `UPDATE jobs.jobs SET status = $2, updated_at = $3, version = version + 1 WHERE id = $1`,
  setJobAttention: `UPDATE jobs.jobs SET needs_attention = true, updated_at = $2 WHERE id = $1`,
  confirmCustomer: `UPDATE jobs.jobs SET customer_verified = true, updated_at = $2, version = version + 1 WHERE id = $1 AND NOT customer_verified`,

  visitsOfJob: `
    SELECT v.id, v.status, lower(v.service_window) AS window_start, upper(v.service_window) AS window_end, v.urgency,
           EXISTS (SELECT 1 FROM jobs.assignments a WHERE a.visit_id = v.id AND a.status = 'ACTIVE') AS assigned
      FROM jobs.visits v WHERE v.job_id = $1 ORDER BY v.sequence_no`,
  visit: `
    SELECT v.id, v.job_id, v.city_id, v.locality_id, v.purposes, v.status, v.urgency, lower(v.service_window) AS window_start,
           upper(v.service_window) AS window_end, v.start_code_hash, v.start_code_attempts, v.arrived_at, v.completed_at,
           v.disclosure_opens_at, v.disclosure_closes_at, v.required_service_type_id, v.repair_order_id, v.completion_code_attempts, v.version,
           j.customer_user_id, j.customer_verified, j.status AS job_status, j.public_ref, j.symptom_codes, j.address_snapshot_enc
      FROM jobs.visits v JOIN jobs.jobs j ON j.id = v.job_id WHERE v.id = $1`,
  lockVisit: `
    SELECT v.id, v.job_id, v.city_id, v.locality_id, v.purposes, v.status, v.urgency, lower(v.service_window) AS window_start,
           upper(v.service_window) AS window_end, v.start_code_hash, v.start_code_attempts, v.arrived_at, v.matching_since, v.version,
           v.repair_order_id, v.completion_code_hash, v.completion_code_attempts
      FROM jobs.visits v WHERE v.id = $1 FOR UPDATE`,
  setVisitStatus: `UPDATE jobs.visits SET status = $2, updated_at = $3, version = version + 1 WHERE id = $1`,
  setVisitMatching: `UPDATE jobs.visits SET status = 'MATCHING', matching_since = $2, updated_at = $2, version = version + 1 WHERE id = $1`,
  setVisitDeparted: `UPDATE jobs.visits SET status = 'EN_ROUTE', departed_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`,
  setVisitArrived: `UPDATE jobs.visits SET status = 'ON_SITE', arrived_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`,
  setVisitWorkStarted: `UPDATE jobs.visits SET status = 'IN_PROGRESS', work_started_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`,
  // A window that never opened (terminal before its start) records no open time.
  setVisitTerminal: `
    UPDATE jobs.visits SET status = $2, terminal_reason_code = $3, disclosure_closes_at = $4, updated_at = $5, version = version + 1,
           disclosure_opens_at = CASE WHEN disclosure_opens_at > $5 THEN NULL ELSE disclosure_opens_at END
     WHERE id = $1`,
  setVisitAssigned: `UPDATE jobs.visits SET status = 'ASSIGNED', disclosure_opens_at = $2, disclosure_closes_at = NULL, updated_at = $3, version = version + 1 WHERE id = $1`,
  setStartCode: `UPDATE jobs.visits SET start_code_hash = $2, updated_at = $3 WHERE id = $1`,
  bumpStartCodeAttempts: `UPDATE jobs.visits SET start_code_attempts = start_code_attempts + 1, updated_at = $2 WHERE id = $1 RETURNING start_code_attempts`,

  activeAssignment: `SELECT id, technician_user_id, created_at FROM jobs.assignments WHERE visit_id = $1 AND status = 'ACTIVE'`,
  latestAssignmentOf: `
    SELECT id, status, created_at, ended_at FROM jobs.assignments
     WHERE visit_id = $1 AND technician_user_id = $2 ORDER BY created_at DESC LIMIT 1`,
  insertAssignment: `
    INSERT INTO jobs.assignments (id, visit_id, technician_user_id, offer_id, assigned_via, assigned_by_actor_type, assigned_by_actor_id,
      manual_reason_code, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9)`,
  endAssignment: `
    UPDATE jobs.assignments SET status = $2, release_reason_code = $3, released_by_actor_type = $4, released_at = $5, ended_at = $5
     WHERE id = $1 AND status = 'ACTIVE'`,
  // INV-03: ACTIVE assignments of the technician whose visit window overlaps this one.
  overlappingAssignments: `
    SELECT count(*)::int AS n FROM jobs.assignments a JOIN jobs.visits v ON v.id = a.visit_id
     WHERE a.technician_user_id = $1 AND a.status = 'ACTIVE' AND v.service_window && tstzrange($2, $3)`,

  presenceProof: `
    INSERT INTO jobs.visit_presence_proofs (id, visit_id, kind, channel, actor_type, actor_id, approval_request_id, reason_code, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  openWait: `SELECT id, started_at FROM jobs.visit_waits WHERE visit_id = $1 AND ended_at IS NULL FOR UPDATE`,
  insertWait: `INSERT INTO jobs.visit_waits (id, visit_id, started_at, start_evidence) VALUES ($1, $2, $3, $4)`,
  endWait: `UPDATE jobs.visit_waits SET ended_at = $2, outcome = $3, billable_minutes = $4, fee_paise = $5 WHERE id = $1`,
  insertCancellation: `
    INSERT INTO jobs.job_cancellations (job_id, visit_id, cancelled_by_actor_type, cancelled_by_actor_id, reason_code, stage,
      customer_fee_paise, technician_compensation_paise, price_snapshot_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  outbox: `
    INSERT INTO platform.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id, city_id, occurred_at)
    VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,

  // Gate 6 (ADR-027): diagnosis checkout, repair orders, repair visits, completion codes.
  setVisitCompleted: `
    UPDATE jobs.visits SET status = 'COMPLETED', completed_at = $2, terminal_reason_code = $3, disclosure_closes_at = $4, updated_at = $2,
           version = version + 1
     WHERE id = $1`,
  setCompletionCode: `UPDATE jobs.visits SET completion_code_hash = $2, updated_at = $3 WHERE id = $1`,
  bumpCompletionCodeAttempts: `
    UPDATE jobs.visits SET completion_code_attempts = completion_code_attempts + 1, updated_at = $2 WHERE id = $1 RETURNING completion_code_attempts`,
  attachRepairToVisit: `
    UPDATE jobs.visits SET purposes = '{DIAGNOSIS,REPAIR}', repair_order_id = $2, completion_code_hash = $3, required_capability = 'DIAGNOSE_AND_REPAIR',
           updated_at = $4, version = version + 1
     WHERE id = $1 AND status = 'IN_PROGRESS' AND purposes = '{DIAGNOSIS}'`,
  nextVisitSequence: `SELECT coalesce(max(sequence_no), 0) + 1 AS n FROM jobs.visits WHERE job_id = $1`,
  insertRepairVisit: `
    INSERT INTO jobs.visits (id, job_id, city_id, locality_id, sequence_no, purposes, repair_order_id, required_service_type_id,
      required_specialization_id, required_capability, service_window, urgency, status, start_code_hash, completion_code_hash, visit_code,
      created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, '{REPAIR}', $6, $7, $8, 'REPAIR', tstzrange($9, $10), $11, 'PLANNED', $12, $13, $14, $15, $15)`,
  visitsOfRepairOrder: `SELECT id, status, sequence_no FROM jobs.visits WHERE repair_order_id = $1 ORDER BY sequence_no`,
  waitFeesOfRepairOrder: `
    SELECT coalesce(sum(w.fee_paise), 0)::bigint AS fees FROM jobs.visit_waits w JOIN jobs.visits v ON v.id = w.visit_id
     WHERE v.repair_order_id = $1 AND w.outcome = 'CUSTOMER_ARRIVED'`,

  repairOrder: `
    SELECT r.id, r.job_id, r.quote_id, r.quote_version_id, r.required_service_type_id, r.required_specialization_id, r.performer_preference,
           r.preferred_technician_user_id, r.allow_fallback, lower(r.preferred_window) AS window_start, upper(r.preferred_window) AS window_end,
           r.materials_required, r.materials_supplied_by, r.materials_confirmed_at, r.status, r.blocked_reason_code, r.version,
           j.customer_user_id, j.city_id, j.status AS job_status, j.visit_fee_snapshot_id
      FROM jobs.repair_orders r JOIN jobs.jobs j ON j.id = r.job_id WHERE r.id = $1`,
  lockRepairOrder: `
    SELECT id, job_id, quote_id, quote_version_id, required_service_type_id, required_specialization_id, performer_preference,
           preferred_technician_user_id, allow_fallback, materials_required, materials_supplied_by, materials_confirmed_at, status, version
      FROM jobs.repair_orders WHERE id = $1 FOR UPDATE`,
  lockOpenRepairOrderOfJob: `
    SELECT id, job_id, quote_id, quote_version_id, required_service_type_id, required_specialization_id, performer_preference,
           preferred_technician_user_id, allow_fallback, materials_required, materials_supplied_by, materials_confirmed_at, status, version
      FROM jobs.repair_orders WHERE job_id = $1 AND status NOT IN ('COMPLETED','CANCELLED') FOR UPDATE`,
  insertRepairOrder: `
    INSERT INTO jobs.repair_orders (id, job_id, quote_id, quote_version_id, required_service_type_id, required_specialization_id, performer_preference,
      preferred_technician_user_id, allow_fallback, preferred_window, materials_required, materials_supplied_by, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE tstzrange($10::timestamptz, $11::timestamptz) END,
            $12, $13, $14, $15, $15)`,
  setRepairOrderStatus: `UPDATE jobs.repair_orders SET status = $2, updated_at = $3, version = version + 1 WHERE id = $1`,
  setRepairOrderScheduled: `
    UPDATE jobs.repair_orders SET status = 'SCHEDULED', preferred_window = tstzrange($2, $3), performer_preference = $4, preferred_technician_user_id = $5,
           allow_fallback = $6, updated_at = $7, version = version + 1
     WHERE id = $1`,
  setRepairOrderBlocked: `UPDATE jobs.repair_orders SET status = 'BLOCKED', blocked_reason_code = $2, updated_at = $3, version = version + 1 WHERE id = $1`,
  setRepairOrderCompleted: `UPDATE jobs.repair_orders SET status = 'COMPLETED', completed_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`,
  setRepairOrderChangeApproved: `
    UPDATE jobs.repair_orders SET status = 'IN_PROGRESS', quote_version_id = $2, materials_required = $3, materials_supplied_by = $4, updated_at = $5,
           version = version + 1
     WHERE id = $1`,
  setMaterialsConfirmed: `UPDATE jobs.repair_orders SET materials_confirmed_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`,

  // Facade reads for the diagnosis module (Gate 6): the visit a diagnosis is captured on, and the job a quote belongs to.
  diagnosisVisitFacts: `
    SELECT v.id, v.job_id, v.city_id, v.status, v.purposes, v.repair_order_id, j.service_type_id, j.customer_user_id, j.status AS job_status,
           j.visit_fee_snapshot_id, j.customer_verified,
           (SELECT a.technician_user_id FROM jobs.assignments a WHERE a.visit_id = v.id AND a.status = 'ACTIVE') AS active_technician_user_id
      FROM jobs.visits v JOIN jobs.jobs j ON j.id = v.job_id WHERE v.id = $1`,
  quoteJobFacts: `
    SELECT j.id, j.customer_user_id, j.city_id, j.status, j.service_type_id, j.visit_fee_snapshot_id, j.customer_verified,
           r.id AS open_repair_order_id, r.status AS open_repair_order_status
      FROM jobs.jobs j LEFT JOIN jobs.repair_orders r ON r.job_id = j.id AND r.status NOT IN ('COMPLETED','CANCELLED')
     WHERE j.id = $1`,

  // Sweeper (06 §13: overdue states are repaired within ~1 minute even if a timer was lost).
  overduePlanned: `
    SELECT id FROM jobs.visits WHERE status = 'PLANNED'
       AND (urgency = 'ASAP' OR lower(service_window) - make_interval(secs => $2::numeric / 1000.0) <= $1) LIMIT $3`,
  overdueMatching: `
    SELECT id FROM jobs.visits WHERE status = 'MATCHING'
       AND matching_since + make_interval(secs => (CASE WHEN urgency = 'ASAP' THEN $2::numeric ELSE $3::numeric END) / 1000.0) <= $1::timestamptz
     LIMIT $4`,
  overdueNoShow: `
    SELECT v.id FROM jobs.visits v
     WHERE v.status IN ('ASSIGNED','EN_ROUTE') AND v.arrived_at IS NULL
       AND lower(v.service_window) + make_interval(secs => $2::numeric / 1000.0) <= $1
       AND NOT EXISTS (SELECT 1 FROM jobs.visit_waits w WHERE w.visit_id = v.id AND w.ended_at IS NULL) LIMIT $3`,
  overdueWaits: `
    SELECT w.visit_id AS id FROM jobs.visit_waits w JOIN jobs.visits v ON v.id = w.visit_id
     WHERE w.ended_at IS NULL AND v.status = 'EN_ROUTE' AND w.started_at + make_interval(secs => $2::numeric / 1000.0) <= $1::timestamptz LIMIT $3`,
  overdueOverrun: `
    SELECT v.id FROM jobs.visits v JOIN jobs.jobs j ON j.id = v.job_id
     WHERE v.status = 'IN_PROGRESS' AND NOT j.needs_attention AND v.arrived_at + make_interval(secs => $2::numeric / 1000.0) <= $1::timestamptz LIMIT $3`,
} as const;
