// SQL of module "pricing" (schema pricing only, B2). Gate 5: read-only rate-card lookups and immutable snapshots.
export const SQL = {
  activeCard: `
    SELECT id, label FROM pricing.rate_cards
     WHERE city_id = $1 AND status = 'ACTIVE' AND effective @> $2::timestamptz`,
  visitFeeItem: `
    SELECT id, labour_paise FROM pricing.rate_card_items
     WHERE rate_card_id = $1 AND target_type = 'VISIT_FEE' AND service_type_id = $2`,
  feeRules: `
    SELECT fee_type, params FROM pricing.fee_rules
     WHERE rate_card_id = $1 AND fee_type IN ('CANCELLATION', 'NO_SHOW', 'WAITING', 'TRAVEL_COMPENSATION')`,
  insertSnapshot: `
    INSERT INTO pricing.price_snapshots (id, rate_card_id, rule_refs, inputs, outputs, engine_version, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  snapshot: `SELECT id, rate_card_id, rule_refs, inputs, outputs, engine_version FROM pricing.price_snapshots WHERE id = $1`,
} as const;
