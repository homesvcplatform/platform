// Synthetic seed loader (Gate 2): loads the Kurnool fixtures into a migrated database. Idempotent: every row has a
// deterministic fixture ID and is inserted with ON CONFLICT DO NOTHING. Runs as the schema owner (migrator) in
// local / CI / dev / test only. Contains no real people, places, numbers or prices.
import { randomBytes } from 'node:crypto';
import type { Queryable } from '@hsp/db';
import {
  ADJACENCY, ADMINS, CATEGORIES, CITY, CUSTOMERS, FIXTURE_EPOCH, fixtureRowId, LOCALITIES, LOCALITY_ALIASES, localityByCode, MATERIALS, must,
  RATE_CARDS, REPAIR_ITEMS, SERVICE_TYPES, serviceTypeId, specializationId, SYMPTOMS, TECHNICIANS, warrantyDays, ZONES,
} from '../fixtures/kurnool.ts';
import { blindIndexFixture, encryptFixture, FIXTURE_KEY_REF, maskPhone } from '../fixtures/synthetic-crypto.ts';

const OPEN_FROM_EPOCH = `[${FIXTURE_EPOCH},)`;

export interface SeedSummary {
  readonly statements: number;
}

export async function loadSyntheticSeed(db: Queryable): Promise<SeedSummary> {
  let statements = 0;
  const run = async (sql: string, params: unknown[]) => {
    statements += 1;
    await db.query(sql, params);
  };
  const approval = (name: string) => fixtureRowId('backoffice.approval_requests', name);

  // Maker-checker approvals for the fixture configuration (INV-19: maker != checker).
  for (const name of ['RATE-CARD-MODEL-B', 'SERVICE-RULES', 'WARRANTY-POLICIES']) {
    await run(
      `INSERT INTO backoffice.approval_requests (id, action_type, resource_type, payload, payload_hash, risk_level,
         requested_by_admin_id, required_approver_permission, decided_by_admin_id, decided_at, status, requested_at, expires_at)
       VALUES ($1, 'FIXTURE_CONFIG', $2, '{"fixture":"NOT_FINAL"}', $3, 'MEDIUM', $4, 'config.approve', $5, $6, 'APPROVED', $6, $7)
       ON CONFLICT DO NOTHING`,
      [approval(name), name, randomBytes(32), ADMINS.maker, ADMINS.checker, FIXTURE_EPOCH, '2027-01-01T00:00:00Z'],
    );
  }

  // geo
  await run(
    `INSERT INTO geo.cities (id, code, names, state_code, supported_locales, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [CITY.id, CITY.code, CITY.names, CITY.stateCode, CITY.locales, CITY.status],
  );
  for (const z of ZONES) {
    const [x1, y1, x2, y2] = z.box as [number, number, number, number];
    const wkt = `SRID=4326;MULTIPOLYGON(((${x1} ${y1}, ${x2} ${y1}, ${x2} ${y2}, ${x1} ${y2}, ${x1} ${y1})))`;
    await run(
      `INSERT INTO geo.zones (id, city_id, code, names, boundary, status) VALUES ($1, $2, $3, $4, ST_GeogFromText($5), 'ACTIVE') ON CONFLICT DO NOTHING`,
      [z.id, CITY.id, z.code, z.names, wkt],
    );
  }
  for (const l of LOCALITIES) {
    await run(
      `INSERT INTO geo.localities (id, city_id, zone_id, code, names, centroid, status)
       VALUES ($1, $2, $3, $4, $5, ST_GeogFromText($6), 'ACTIVE') ON CONFLICT DO NOTHING`,
      [l.id, CITY.id, l.zoneId, l.code, l.names, `SRID=4326;POINT(${l.lon} ${l.lat})`],
    );
  }
  for (const e of ADJACENCY) {
    await run(
      `INSERT INTO geo.locality_adjacency (locality_id, neighbor_id, travel_minutes_typical, source) VALUES ($1, $2, $3, 'OPS_CURATED') ON CONFLICT DO NOTHING`,
      [e.from, e.to, e.minutes],
    );
  }
  for (const a of LOCALITY_ALIASES) {
    await run(
      `INSERT INTO geo.locality_aliases (id, locality_id, alias, script, normalized) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [fixtureRowId('geo.locality_aliases', `${a.locality}/${a.normalized}`), localityByCode(a.locality).id, a.alias, a.script, a.normalized],
    );
  }

  // catalog
  for (const c of CATEGORIES) {
    await run(
      `INSERT INTO catalog.service_categories (id, code, names, sort_order, status) VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [c.id, c.code, c.names, c.sortOrder],
    );
  }
  for (const t of SERVICE_TYPES) {
    const category = must(CATEGORIES.find((c) => c.code === t.category), t.category);
    await run(
      `INSERT INTO catalog.service_types (id, category_id, code, names, status) VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [t.id, category.id, t.code, t.names],
    );
    for (const s of t.specializations) {
      await run(
        `INSERT INTO catalog.specializations (id, service_type_id, code, names, status) VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT DO NOTHING`,
        [specializationId(t.code, s), t.id, s, { en: s.replaceAll('_', ' ').toLowerCase() }],
      );
    }
    await run(
      `INSERT INTO catalog.service_rules (id, service_type_id, city_id, rules, effective, status, approval_request_id)
       VALUES ($1, $2, $3, $4, $5::tstzrange, 'ACTIVE', $6) ON CONFLICT DO NOTHING`,
      [
        fixtureRowId('catalog.service_rules', `${CITY.code}/${t.code}`),
        t.id,
        CITY.id,
        { enabled: t.enabledInCity, same_visit_repair_allowed: true, quote_expiry_hours: 48, min_verification_level: 1, fixture: 'NOT_FINAL' },
        OPEN_FROM_EPOCH,
        approval('SERVICE-RULES'),
      ],
    );
  }
  for (const s of SYMPTOMS) {
    await run(
      `INSERT INTO catalog.symptoms (id, service_type_id, code, names, status) VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [fixtureRowId('catalog.symptoms', `${s.serviceType}/${s.code}`), serviceTypeId(s.serviceType), s.code, { en: s.en, te: s.te }],
    );
  }
  for (const r of REPAIR_ITEMS) {
    await run(
      `INSERT INTO catalog.repair_items (id, service_type_id, code, keypad_code, names, required_service_type_id,
         required_specialization_id, warranty_policy_code, status)
       VALUES ($1, $2, $3, $4, $5, $2, $6, $7, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [
        fixtureRowId('catalog.repair_items', r.code), serviceTypeId(r.serviceType), r.code, r.keypad, { en: r.en },
        r.specialization ? specializationId(r.serviceType, r.specialization) : null, `WP-${r.code}`,
      ],
    );
  }
  for (const m of MATERIALS) {
    const materialId = fixtureRowId('catalog.materials', m.code);
    await run(
      `INSERT INTO catalog.materials (id, code, names, unit, status) VALUES ($1, $2, $3, $4, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [materialId, m.code, { en: m.en }, m.unit],
    );
    await run(
      `INSERT INTO catalog.material_reference_prices (id, material_id, city_id, unit_price_paise, effective, source)
       VALUES ($1, $2, $3, $4, $5::tstzrange, 'FIXTURE_NOT_FINAL') ON CONFLICT DO NOTHING`,
      [fixtureRowId('catalog.material_reference_prices', `${CITY.code}/${m.code}`), materialId, CITY.id, m.testPricePaise, OPEN_FROM_EPOCH],
    );
  }

  // pricing (fixture rate cards: TEST VALUES ONLY, NOT FINAL)
  for (const card of RATE_CARDS) {
    const active = card.status === 'ACTIVE';
    await run(
      `INSERT INTO pricing.rate_cards (id, city_id, version_no, label, status, effective, created_by_admin_id, approval_request_id)
       VALUES ($1, $2, $3, $4, $5, $6::tstzrange, $7, $8) ON CONFLICT DO NOTHING`,
      [card.id, CITY.id, card.versionNo, card.label, card.status, active ? OPEN_FROM_EPOCH : null, ADMINS.maker, active ? approval('RATE-CARD-MODEL-B') : null],
    );
    for (const t of SERVICE_TYPES.filter((s) => s.enabledInCity)) {
      await run(
        `INSERT INTO pricing.rate_card_items (id, rate_card_id, target_type, service_type_id, labour_paise, min_paise, max_paise, technician_share_bps)
         VALUES ($1, $2, 'VISIT_FEE', $3, $4, $4, $4, $5) ON CONFLICT DO NOTHING`,
        [fixtureRowId('pricing.rate_card_items', `${card.label}/VISIT_FEE/${t.code}`), card.id, t.id, card.visitFeePaise, card.shareBps],
      );
    }
    for (const [i, r] of REPAIR_ITEMS.entries()) {
      const labour = card.labourBasePaise + i * 1000;
      await run(
        `INSERT INTO pricing.rate_card_items (id, rate_card_id, target_type, repair_item_id, labour_paise, min_paise, max_paise, technician_share_bps)
         VALUES ($1, $2, 'REPAIR_ITEM', $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [fixtureRowId('pricing.rate_card_items', `${card.label}/${r.code}`), card.id, fixtureRowId('catalog.repair_items', r.code),
         labour, Math.floor(labour / 2), labour * 2, card.shareBps],
      );
    }
    for (const [feeType, params] of [
      ['PLATFORM_FEE', { bps: 1000, fixture: 'NOT_FINAL' }],
      ['DIAGNOSIS_PAYOUT', { amount_paise: 10000, fixture: 'NOT_FINAL' }],
      // Gate 5 lifecycle fees (06 §10), test values only, NOT FINAL.
      ['CANCELLATION', { free_cancel_lead_minutes: 120, late_cancel_paise: 4900, en_route_paise: 9900, technician_share_bps: 7500, fixture: 'NOT_FINAL' }],
      ['NO_SHOW', { customer_fee_paise: 9900, technician_compensation_paise: 7500, fixture: 'NOT_FINAL' }],
      ['WAITING', { grace_minutes: 10, per_minute_paise: 200, cap_paise: 6000, technician_share_bps: 7500, fixture: 'NOT_FINAL' }],
      ['TRAVEL_COMPENSATION', { amount_paise: 5000, fixture: 'NOT_FINAL' }],
    ] as const) {
      await run(
        `INSERT INTO pricing.fee_rules (id, rate_card_id, fee_type, params) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [fixtureRowId('pricing.fee_rules', `${card.label}/${feeType}`), card.id, feeType, params],
      );
    }
  }

  // warranty policies per repair item
  for (const r of REPAIR_ITEMS) {
    await run(
      `INSERT INTO warranty.warranty_policies (id, code, version_no, scope_type, scope_id, duration_days, cost_bearer, status, effective, approval_request_id)
       VALUES ($1, $2, 1, 'REPAIR_ITEM', $3, $4, 'ORIGINAL_TECHNICIAN', 'ACTIVE', $5::tstzrange, $6) ON CONFLICT DO NOTHING`,
      [fixtureRowId('warranty.warranty_policies', r.code), `WP-${r.code}`, fixtureRowId('catalog.repair_items', r.code), warrantyDays(r.code),
       OPEN_FROM_EPOCH, approval('WARRANTY-POLICIES')],
    );
  }

  // people (synthetic): identity user + per-person key, then profile
  const insertUser = async (userId: string, phone: string, locale: string) => {
    await run(
      `INSERT INTO identity.users (id, phone_enc, phone_bidx, phone_masked, preferred_locale, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [userId, encryptFixture(phone), blindIndexFixture(phone), maskPhone(phone), locale],
    );
    await run(
      `INSERT INTO identity.subject_keys (user_id, data_class, wrapped_dek, kms_key_arn) VALUES ($1, 'pii-contact', $2, $3) ON CONFLICT DO NOTHING`,
      [userId, randomBytes(48), FIXTURE_KEY_REF],
    );
  };

  for (const t of TECHNICIANS) {
    await insertUser(t.userId, t.phone, 'te-IN');
    const home = localityByCode(t.homeLocality);
    await run(
      `INSERT INTO workforce.technician_profiles (user_id, legal_name_enc, display_name, device_mode, city_id, home_locality_id, languages,
         experience_years, birth_year, onboarding_status, status, ivr_locale)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY['te','en'], 5, 1990, 'READY', 'ACTIVE', 'te-IN') ON CONFLICT DO NOTHING`,
      [t.userId, encryptFixture(`${t.displayName} (synthetic)`), t.displayName, t.deviceMode, CITY.id, home.id],
    );
    const skills: (string | null)[] = [null, ...t.specializations];
    for (const s of skills) {
      await run(
        `INSERT INTO workforce.technician_skills (id, technician_user_id, service_type_id, specialization_id, level, can_diagnose, can_repair,
           verified_by_admin_id, verified_at, status)
         VALUES ($1, $2, $3, $4, $5, true, true, $6, $7, 'ACTIVE') ON CONFLICT DO NOTHING`,
        [fixtureRowId('workforce.technician_skills', `${t.key}/${t.serviceType}/${s ?? '-'}`), t.userId, serviceTypeId(t.serviceType),
         s ? specializationId(t.serviceType, s) : null, t.level, ADMINS.checker, FIXTURE_EPOCH],
      );
    }
    await run(
      `INSERT INTO workforce.technician_service_areas (id, technician_user_id, locality_id, priority) VALUES ($1, $2, $3, 'PRIMARY') ON CONFLICT DO NOTHING`,
      [fixtureRowId('workforce.technician_service_areas', `${t.key}/${home.code}`), t.userId, home.id],
    );
    for (const edge of ADJACENCY.filter((e) => e.from === home.id)) {
      await run(
        `INSERT INTO workforce.technician_service_areas (id, technician_user_id, locality_id, priority) VALUES ($1, $2, $3, 'SECONDARY') ON CONFLICT DO NOTHING`,
        [fixtureRowId('workforce.technician_service_areas', `${t.key}/${edge.to}`), t.userId, edge.to],
      );
    }
  }

  for (const c of CUSTOMERS) {
    await insertUser(c.userId, c.phone, c.locale);
    await run(
      `INSERT INTO customers.customer_profiles (user_id, display_name_enc, preferred_locale, preferred_language) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [c.userId, encryptFixture(`Test Customer ${c.key}`), c.locale, c.language],
    );
    const locality = localityByCode(c.locality);
    await run(
      `INSERT INTO customers.addresses (id, customer_user_id, city_id, locality_id, label, line1_enc, landmark_enc, point_coarse)
       VALUES ($1, $2, $3, $4, 'Home', $5, $6, ST_GeogFromText($7)) ON CONFLICT DO NOTHING`,
      [c.addressId, c.userId, CITY.id, locality.id, encryptFixture(c.line1), encryptFixture(c.landmark), `SRID=4326;POINT(${locality.lon} ${locality.lat})`],
    );
  }

  return { statements };
}
