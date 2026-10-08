// Synthetic seed loader: loads the Kurnool fixtures idempotently and satisfies every constraint on the way in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db-harness.ts';
import { decryptFixture, isReservedTestPhone } from '../../fixtures/synthetic-crypto.ts';
import { CITY, CUSTOMERS, SERVICE_TYPES, TECHNICIANS } from '../../fixtures/kurnool.ts';
import { loadSyntheticSeed } from '../../seed/load.ts';

let db: TestDatabase;

async function counts() {
  const r = await db.migrator.query(`SELECT
    (SELECT count(*) FROM geo.cities)::int AS cities, (SELECT count(*) FROM geo.zones)::int AS zones,
    (SELECT count(*) FROM geo.localities)::int AS localities, (SELECT count(*) FROM catalog.service_categories)::int AS categories,
    (SELECT count(*) FROM catalog.service_types)::int AS service_types, (SELECT count(*) FROM catalog.repair_items)::int AS repair_items,
    (SELECT count(*) FROM pricing.rate_cards)::int AS rate_cards, (SELECT count(*) FROM workforce.technician_profiles)::int AS technicians,
    (SELECT count(*) FROM customers.customer_profiles)::int AS customers, (SELECT count(*) FROM identity.users)::int AS users,
    (SELECT count(*) FROM workforce.technician_skills)::int AS skills, (SELECT count(*) FROM warranty.warranty_policies)::int AS warranty_policies`);
  return r.rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.migrator.query('BEGIN');
  await loadSyntheticSeed(db.migrator);
  await db.migrator.query('COMMIT');
});
afterAll(async () => {
  await db?.close();
});

describe('synthetic seed', () => {
  it('loads the pilot fixture set', async () => {
    expect(await counts()).toEqual({
      cities: 1, zones: 2, localities: 12, categories: 3, service_types: 13, repair_items: 14, rate_cards: 2,
      technicians: 7, customers: 4, users: 11, skills: 7 + TECHNICIANS.reduce((n, t) => n + t.specializations.length, 0), warranty_policies: 14,
    });
  });

  it('is idempotent', async () => {
    const before = await counts();
    await db.migrator.query('BEGIN');
    await loadSyntheticSeed(db.migrator);
    await db.migrator.query('COMMIT');
    expect(await counts()).toEqual(before);
  });

  it('uses only reserved fake phone numbers, stored encrypted with a blind index and a mask', async () => {
    const r = await db.migrator.query('SELECT phone_enc, phone_masked FROM identity.users');
    expect(r.rows).toHaveLength(TECHNICIANS.length + CUSTOMERS.length);
    for (const row of r.rows) {
      const phone = decryptFixture(row.phone_enc as Buffer);
      expect(isReservedTestPhone(phone), phone).toBe(true);
      expect(row.phone_masked).toContain('•');
      expect(row.phone_masked).not.toContain(phone.slice(5, 11));
    }
  });

  it('enables the slice service types in the synthetic city by data, AC included for the regression scenario', async () => {
    const r = await db.migrator.query(
      `SELECT t.code, (r.rules ->> 'enabled')::boolean AS enabled FROM catalog.service_rules r JOIN catalog.service_types t ON t.id = r.service_type_id
        WHERE r.city_id = $1 AND r.status = 'ACTIVE' ORDER BY t.code`, [CITY.id]);
    const enabled = r.rows.filter((x) => x.enabled).map((x) => x.code).sort();
    expect(enabled).toEqual(SERVICE_TYPES.filter((t) => t.enabledInCity).map((t) => t.code).sort());
    expect(enabled).toEqual(['AC', 'AIR_COOLER', 'ELECTRICAL_GENERAL', 'GEYSER', 'PLUMBING_GENERAL', 'REFRIGERATOR', 'RO_WATER_PURIFIER', 'WASHING_MACHINE']);
  });

  it('keeps skills service-type specific: only T-FRG-2 holds refrigerator GAS_REFRIGERATION; T-RO-1 / T-AC-1 hold no refrigerator skill', async () => {
    const r = await db.migrator.query(
      `SELECT p.display_name, t.code AS service_type, sp.code AS specialization
         FROM workforce.technician_skills s
         JOIN workforce.technician_profiles p ON p.user_id = s.technician_user_id
         JOIN catalog.service_types t ON t.id = s.service_type_id
         LEFT JOIN catalog.specializations sp ON sp.id = s.specialization_id
        WHERE s.status = 'ACTIVE'`);
    const gas = r.rows.filter((x) => x.service_type === 'REFRIGERATOR' && x.specialization === 'GAS_REFRIGERATION').map((x) => x.display_name);
    expect(gas).toEqual(['Test Fridge Specialist']);
    const fridgeHolders = new Set(r.rows.filter((x) => x.service_type === 'REFRIGERATOR').map((x) => x.display_name));
    expect(fridgeHolders).toEqual(new Set(['Test Fridge Tech One', 'Test Fridge Specialist']));
  });

  it('IVR keypad codes are scoped per service type (21 exists under several types)', async () => {
    const r = await db.migrator.query(
      "SELECT count(DISTINCT service_type_id)::int AS types FROM catalog.repair_items WHERE keypad_code = '21'");
    expect(r.rows[0].types).toBeGreaterThan(1);
  });

  it('fixture rate cards are labelled NOT FINAL; only Model B is active', async () => {
    const r = await db.migrator.query('SELECT label, status FROM pricing.rate_cards ORDER BY version_no');
    expect(r.rows).toEqual([
      { label: 'MODEL_B_FIXTURE_NOT_FINAL', status: 'ACTIVE' },
      { label: 'MODEL_C_FIXTURE_NOT_FINAL', status: 'DRAFT' },
    ]);
  });
});
