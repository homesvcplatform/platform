// SQL of module "pricing" (schema pricing only, B2). Gate 5: read-only rate-card lookups and immutable snapshots.
// Gate 6: the quote engine's rate-card reads (repair-item labour, platform fee, material markup, visit-fee credit).
export const SQL = {
  activeCard: `
    SELECT id, label FROM pricing.rate_cards
     WHERE city_id = $1 AND status = 'ACTIVE' AND effective @> $2::timestamptz`,
  card: `SELECT id, city_id, status FROM pricing.rate_cards WHERE id = $1`,
  visitFeeItem: `
    SELECT id, labour_paise FROM pricing.rate_card_items
     WHERE rate_card_id = $1 AND target_type = 'VISIT_FEE' AND service_type_id = $2`,
  repairItems: `
    SELECT id, repair_item_id, labour_paise, min_paise, max_paise, technician_share_bps FROM pricing.rate_card_items
     WHERE rate_card_id = $1 AND target_type = 'REPAIR_ITEM' AND repair_item_id = ANY($2::uuid[])`,
  feeRules: `
    SELECT fee_type, params FROM pricing.fee_rules
     WHERE rate_card_id = $1 AND fee_type IN ('CANCELLATION', 'NO_SHOW', 'WAITING', 'TRAVEL_COMPENSATION')`,
  quoteFeeRules: `
    SELECT id, fee_type, params FROM pricing.fee_rules
     WHERE rate_card_id = $1 AND fee_type IN ('PLATFORM_FEE', 'MATERIAL_MARKUP', 'VISIT_FEE_CREDIT', 'DIAGNOSIS_PAYOUT')`,
  insertSnapshot: `
    INSERT INTO pricing.price_snapshots (id, rate_card_id, rule_refs, inputs, outputs, engine_version, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  snapshot: `SELECT id, rate_card_id, rule_refs, inputs, outputs, engine_version FROM pricing.price_snapshots WHERE id = $1`,
} as const;
