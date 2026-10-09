// SQL of module "catalog" (schema catalog only, B2).

/** The effective rule per service type for a city at a time: the city's ACTIVE rule, else the default (city NULL) one. */
const EFFECTIVE_RULES = `
  SELECT DISTINCT ON (r.service_type_id) r.service_type_id, r.rules, r.city_id
    FROM catalog.service_rules r
   WHERE r.status = 'ACTIVE' AND r.effective @> $2::timestamptz AND (r.city_id = $1 OR r.city_id IS NULL)
   ORDER BY r.service_type_id, (r.city_id IS NULL)`;

export const SQL = {
  // Active service types of active categories, with their effective rule for the city (filtered by the service).
  offeredTypes: `
    WITH eff AS (${EFFECTIVE_RULES})
    SELECT c.id AS category_id, c.code AS category_code, c.names AS category_names, c.sort_order,
           t.id, t.code, t.names, t.icon_ref, eff.rules
      FROM catalog.service_types t
      JOIN catalog.service_categories c ON c.id = t.category_id
      JOIN eff ON eff.service_type_id = t.id
     WHERE t.status = 'ACTIVE' AND c.status = 'ACTIVE'
     ORDER BY c.sort_order, c.code, t.code`,
  serviceType: `
    SELECT t.id, t.code, t.names, t.status, c.status AS category_status
      FROM catalog.service_types t JOIN catalog.service_categories c ON c.id = t.category_id
     WHERE t.id = $1`,
  effectiveRule: `
    SELECT r.rules, r.city_id FROM catalog.service_rules r
     WHERE r.service_type_id = $1 AND r.status = 'ACTIVE' AND r.effective @> $3::timestamptz AND (r.city_id = $2 OR r.city_id IS NULL)
     ORDER BY (r.city_id IS NULL) LIMIT 1`,
  symptoms: `
    SELECT code, names FROM catalog.symptoms WHERE service_type_id = $1 AND status = 'ACTIVE' ORDER BY sort_order, code`,
  repairItems: `
    SELECT id, code, keypad_code, names, required_service_type_id, required_specialization_id, warranty_policy_code
      FROM catalog.repair_items WHERE service_type_id = $1 AND status = 'ACTIVE' ORDER BY keypad_code NULLS LAST, code`,
  // IVR keypad codes are service-type-specific (ADR-020): "21" under REFRIGERATOR is not "21" under RO_WATER_PURIFIER.
  repairItemByKeypad: `
    SELECT id, code, keypad_code, names, required_service_type_id, required_specialization_id, warranty_policy_code
      FROM catalog.repair_items WHERE service_type_id = $1 AND keypad_code = $2 AND status = 'ACTIVE'`,
  materialReference: `
    SELECT p.unit_price_paise, m.unit FROM catalog.material_reference_prices p JOIN catalog.materials m ON m.id = p.material_id
     WHERE p.material_id = $1 AND p.city_id = $2 AND p.effective @> $3::timestamptz AND m.status = 'ACTIVE'`,

  // Approved service-rule changes (ADR-025 #7): cut the rule in force at the start, retire later-dated ones, insert.
  lockServiceType: `SELECT id FROM catalog.service_types WHERE id = $1 FOR UPDATE`,
  ruleOfChangeRequest: `SELECT id FROM catalog.service_rules WHERE approval_request_id = $1 AND service_type_id = $2 AND city_id IS NOT DISTINCT FROM $3::uuid`,
  cutActiveRules: `
    UPDATE catalog.service_rules SET effective = tstzrange(lower(effective), $3::timestamptz)
     WHERE service_type_id = $1 AND city_id IS NOT DISTINCT FROM $2::uuid AND status = 'ACTIVE'
       AND (lower_inf(effective) OR lower(effective) < $3::timestamptz) AND (upper_inf(effective) OR upper(effective) > $3::timestamptz)`,
  retireLaterRules: `
    UPDATE catalog.service_rules SET status = 'RETIRED'
     WHERE service_type_id = $1 AND city_id IS NOT DISTINCT FROM $2::uuid AND status = 'ACTIVE'
       AND NOT lower_inf(effective) AND lower(effective) >= $3::timestamptz`,
  insertRule: `
    INSERT INTO catalog.service_rules (id, service_type_id, city_id, rules, effective, status, approval_request_id)
    VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, NULL), 'ACTIVE', $6)`,
} as const;
