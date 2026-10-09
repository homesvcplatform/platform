// Gate 4 exit criteria on the public reads (04 §5–§6, 13 §12, ADR-020, ADR-025): the catalog lists only service types
// that are ACTIVE and enabled for the city by data (a rule change shows up without a restart or deploy), keypad codes
// resolve within a service type, names follow the city's locales with an English fallback, and geo search,
// serviceability, zones and travel estimates work over the synthetic Kurnool-like city. Throwaway database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { normalizeSearchText } from '@hsp/module-geo';
import { kurnool, loadSyntheticSeed } from '@hsp/testing';
import { createApiHarness, meta, type ApiHarness } from './harness.ts';

let h: ApiHarness;
const { CITY, SERVICE_TYPES, LOCALITIES, LOCALITY_ALIASES, ADJACENCY, MATERIALS, serviceTypeId, localityByCode, fixtureRowId } = kurnool;

beforeAll(async () => {
  h = await createApiHarness();
  await loadSyntheticSeed(h.db.migrator);
});
afterAll(async () => {
  await h?.close();
});

const catalog = (path: string, query: Record<string, string>, ip?: string) =>
  h.api.catalogHttp({ method: 'GET', path, query, headers: {}, meta: meta(ip) });
const geo = (method: 'GET' | 'POST', path: string, input: { query?: Record<string, string>; body?: unknown }, ip?: string) =>
  h.api.geoHttp({ method, path, headers: {}, meta: meta(ip), ...input });

type Categories = { locale: string; categories: { code: string; label: string; serviceTypes: { id: string; code: string; label: string }[] }[] };
async function offered(cityId: string = CITY.id, locale?: string): Promise<Categories> {
  const r = await catalog('/v1/catalog/categories', { cityId, ...(locale ? { locale } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Categories;
}
const codes = (c: Categories) => c.categories.flatMap((x) => x.serviceTypes.map((t) => t.code)).sort();

/** A rule written as data (stands in for an approved change; the admin flow is tested in admin-api). Same cut / retire as execution. */
async function setCityRule(code: string, rules: unknown, cityId: string | null = CITY.id, from = h.clock.now()) {
  const st = serviceTypeId(code);
  await h.db.migrator.query(`UPDATE catalog.service_rules SET effective = tstzrange(lower(effective), $3)
    WHERE service_type_id = $1 AND city_id IS NOT DISTINCT FROM $2::uuid AND status = 'ACTIVE' AND lower(effective) < $3
      AND (upper_inf(effective) OR upper(effective) > $3)`, [st, cityId, from]);
  await h.db.migrator.query(`UPDATE catalog.service_rules SET status = 'RETIRED'
    WHERE service_type_id = $1 AND city_id IS NOT DISTINCT FROM $2::uuid AND status = 'ACTIVE' AND lower(effective) >= $3`, [st, cityId, from]);
  await h.db.migrator.query(`INSERT INTO catalog.service_rules (id, service_type_id, city_id, rules, effective, status)
    VALUES ($1, $2, $3, $4, tstzrange($5, NULL), 'ACTIVE')`, [newId(), st, cityId, JSON.stringify(rules), from]);
}

describe('catalog: what a city offers is data (ADR-020)', () => {
  it('lists the enabled pilot service types under 3 categories; disabled and other types are absent', async () => {
    const c = await offered(CITY.id, 'en-IN');
    expect(c.categories.map((x) => x.code)).toEqual(['PLUMBING', 'ELECTRICAL', 'APPLIANCE_HOME_EQUIPMENT']);
    expect(codes(c)).toEqual(SERVICE_TYPES.filter((t) => t.enabledInCity).map((t) => t.code).sort());
    for (const disabled of ['PLUMBING_TANK_MOTOR', 'INVERTER', 'MIXER_GRINDER', 'MICROWAVE', 'TV']) expect(codes(c)).not.toContain(disabled);
    expect(c.categories[2]?.serviceTypes.length).toBeGreaterThanOrEqual(3); // 13 §12: ≥ 3 appliance service types
  });

  it('answers in the city primary locale by default (X-05), in another offered locale on request, else falls back', async () => {
    const te = await offered();
    expect(te.locale).toBe('te-IN');
    expect(te.categories[0]?.label).toBe('ప్లంబింగ్');
    expect((await offered(CITY.id, 'en-IN')).categories[0]?.label).toBe('Plumbing');
    expect((await offered(CITY.id, 'hi-IN')).locale).toBe('te-IN');
  });

  it('is cacheable for 5 minutes and validates its query strictly', async () => {
    const ok = await catalog('/v1/catalog/categories', { cityId: CITY.id });
    expect(ok.headers['cache-control']).toBe('public, max-age=300');
    expect((await catalog('/v1/catalog/categories', {})).status).toBe(400);
    expect((await catalog('/v1/catalog/categories', { cityId: CITY.id, debug: '1' })).status).toBe(400);
    expect((await catalog('/v1/catalog/categories', { cityId: newId() })).status).toBe(404);
  });

  it('enabling and disabling a service type for the city changes the output with no restart or deploy', async () => {
    expect(codes(await offered())).not.toContain('INVERTER');
    await setCityRule('INVERTER', { enabled: true, fixture: 'NOT_FINAL' });
    expect(codes(await offered())).toContain('INVERTER');
    await setCityRule('INVERTER', { enabled: false, fixture: 'NOT_FINAL' });
    expect(codes(await offered())).not.toContain('INVERTER');
  });

  it('a future-dated rule applies only from its start', async () => {
    const start = new Date(h.clock.now().getTime() + 3_600_000);
    await setCityRule('MICROWAVE', { enabled: true }, CITY.id, start);
    expect(codes(await offered())).not.toContain('MICROWAVE');
    h.clock.advance(3_600_000 + 1_000);
    expect(codes(await offered())).toContain('MICROWAVE');
    await setCityRule('MICROWAVE', { enabled: false });
  });

  it('a city rule overrides the default rule; a city without its own rule gets the default; no rule = not offered', async () => {
    const other = newId();
    await h.db.migrator.query(`INSERT INTO geo.cities (id, code, names, state_code, supported_locales, status)
      VALUES ($1, 'TSTB', '{"en":"Second test city"}', 'IN-AP', '{en-IN}', 'PLANNED')`, [other]);
    expect(codes(await offered(other))).toEqual([]);
    await setCityRule('PLUMBING_GENERAL', { enabled: true }, null); // default for every city
    await setCityRule('TV', { enabled: true }, null);
    expect(codes(await offered(other))).toEqual(['PLUMBING_GENERAL', 'TV']);
    expect((await offered(other)).locale).toBe('en-IN');
    expect(codes(await offered())).not.toContain('TV'); // Kurnool's own TV rule (disabled) wins over the default
  });

  it('a hidden category or service type, or an invalid rule, never shows (fail closed)', async () => {
    await h.db.migrator.query("UPDATE catalog.service_types SET status = 'HIDDEN' WHERE id = $1", [serviceTypeId('GEYSER')]);
    expect(codes(await offered())).not.toContain('GEYSER');
    await h.db.migrator.query("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE id = $1", [serviceTypeId('GEYSER')]);
    await setCityRule('AIR_COOLER', { enabled: 'yes' });
    expect(codes(await offered())).not.toContain('AIR_COOLER');
    expect(h.logs.some((l) => l.includes('catalog.invalid_service_rule'))).toBe(true);
    await setCityRule('AIR_COOLER', { enabled: true, fixture: 'NOT_FINAL' });
    expect(codes(await offered())).toContain('AIR_COOLER');
  });

  it('symptoms only for a service type offered in the city; a missing translation falls back to English and is counted', async () => {
    const r = await catalog(`/v1/catalog/service-types/${serviceTypeId('REFRIGERATOR')}/symptoms`, { cityId: CITY.id });
    expect(r.status).toBe(200);
    const items = (r.body as { items: { code: string; label: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect((await catalog(`/v1/catalog/service-types/${serviceTypeId('INVERTER')}/symptoms`, { cityId: CITY.id })).status).toBe(404);
    expect((await catalog(`/v1/catalog/service-types/${newId()}/symptoms`, { cityId: CITY.id })).status).toBe(404);
    const first = items[0]?.code ?? '';
    await h.db.migrator.query(`UPDATE catalog.symptoms SET names = names - 'te' WHERE service_type_id = $1 AND code = $2`, [serviceTypeId('REFRIGERATOR'), first]);
    const before = h.logs.filter((l) => l.includes('i18n.fallback')).length;
    const again = (await catalog(`/v1/catalog/service-types/${serviceTypeId('REFRIGERATOR')}/symptoms`, { cityId: CITY.id })).body as { items: { code: string; label: string }[] };
    expect(again.items.find((i) => i.code === first)?.label).toMatch(/^[\x20-\x7e]+$/);
    expect(h.logs.filter((l) => l.includes('i18n.fallback')).length).toBe(before + 1);
  });

  it('keypad codes resolve within the service type: "21" differs between REFRIGERATOR and RO (ADR-020)', async () => {
    expect((await h.api.catalog.resolveKeypadCode(serviceTypeId('REFRIGERATOR'), '21'))?.code).toBe('REP-FRIDGE-THERMOSTAT-REPLACE');
    expect((await h.api.catalog.resolveKeypadCode(serviceTypeId('RO_WATER_PURIFIER'), '21'))?.code).toBe('REP-RO-FILTER-SET-REPLACE');
    expect(await h.api.catalog.resolveKeypadCode(serviceTypeId('REFRIGERATOR'), '99')).toBeNull();
    expect(await h.api.catalog.resolveKeypadCode(serviceTypeId('REFRIGERATOR'), '2a')).toBeNull();
    const fridge = await h.api.catalog.getRepairItems(serviceTypeId('REFRIGERATOR'));
    expect(fridge.every((i) => i.requiredServiceTypeId === serviceTypeId('REFRIGERATOR'))).toBe(true);
    expect(fridge.find((i) => i.code === 'REP-FRIDGE-GAS-CHARGE')?.requiredSpecializationId).toBe(kurnool.specializationId('REFRIGERATOR', 'GAS_REFRIGERATION'));
  });

  it('service rules and material reference prices are read at a point in time', async () => {
    expect(await h.api.catalog.getServiceRules(serviceTypeId('REFRIGERATOR'), CITY.id)).toMatchObject({ enabled: true, fixture: 'NOT_FINAL' });
    const m = kurnool.must(MATERIALS[0], 'material');
    const ref = await h.api.catalog.getMaterialReference(fixtureRowId('catalog.materials', m.code), CITY.id);
    expect(ref?.unitPricePaise).toBe(BigInt(m.testPricePaise));
    expect(await h.api.catalog.getMaterialReference(fixtureRowId('catalog.materials', m.code), CITY.id, new Date('2025-01-01T00:00:00Z'))).toBeNull();
  });

  it('public reads are rate-limited per client IP (04 §5)', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 30; i += 1) expect((await catalog('/v1/catalog/categories', { cityId: CITY.id }, ip)).status).toBe(200);
    const limited = await catalog('/v1/catalog/categories', { cityId: CITY.id }, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await geo('GET', '/v1/geo/localities', { query: { cityId: CITY.id, q: 'nagar' } }, ip)).status).toBe(429);
  });
});

describe('geo: locality search, serviceability, zones, travel', () => {
  type Search = { locale: string; items: { id: string; name: string; zoneName: string; isServiceable: boolean }[] };
  const search = async (q: string, locale?: string) => {
    const r = await geo('GET', '/v1/geo/localities', { query: { cityId: CITY.id, q, ...(locale ? { locale } : {}) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Search;
  };

  it('finds localities by name in either script and by alias, with typo tolerance, at most 20', async () => {
    expect((await search('Test Nagar 3', 'en-IN')).items[0]).toMatchObject({ id: localityByCode('LOC-03').id, name: 'Test Nagar 3', isServiceable: true });
    expect((await search('టెస్ట్ నగర్ 3')).items[0]).toMatchObject({ id: localityByCode('LOC-03').id, name: 'టెస్ట్ నగర్ 3', zoneName: 'ఉత్తర పరీక్ష జోన్' });
    expect((await search('రైల్వే')).items[0]?.id).toBe(localityByCode('LOC-05').id);
    expect((await search('OLD market')).items[0]?.id).toBe(localityByCode('LOC-09').id);
    expect((await search('railwy colony')).items[0]?.id).toBe(localityByCode('LOC-05').id);
    expect((await search('nagar')).items.length).toBe(LOCALITIES.length);
    expect((await search('x')).items).toEqual([]);
    expect((await search('zzzz-unknown')).items).toEqual([]);
  });

  it('seeded alias normalisation matches the module rule', () => {
    for (const a of LOCALITY_ALIASES) expect(a.normalized).toBe(normalizeSearchText(a.alias));
  });

  it('serviceability by locality and by point; outside zones is not serviceable; outside India is refused', async () => {
    const post = async (body: unknown) => {
      const r = await geo('POST', '/v1/geo/serviceability', { body });
      return { status: r.status, body: r.body as { serviceable: boolean; localityId?: string; cityId?: string } };
    };
    const loc = localityByCode('LOC-02');
    expect((await post({ localityId: loc.id })).body).toEqual({ serviceable: true, cityId: CITY.id, localityId: loc.id });
    expect((await post({ point: { lat: loc.lat + 0.001, lng: loc.lon } })).body).toMatchObject({ serviceable: true, localityId: loc.id });
    expect((await post({ point: { lat: 15.5, lng: 78.0 } })).body).toEqual({ serviceable: false });
    expect((await post({ point: { lat: 51.5, lng: -0.12 } })).status).toBe(400);
    expect((await post({ localityId: newId() })).body).toEqual({ serviceable: false });
    expect((await post({ localityId: loc.id, extra: true })).status).toBe(400);
  });

  it('an inactive locality, an inactive zone or a paused city is not serviceable', async () => {
    const loc = localityByCode('LOC-08');
    const check = async () => ((await geo('POST', '/v1/geo/serviceability', { body: { localityId: loc.id } })).body as { serviceable: boolean }).serviceable;
    await h.db.migrator.query("UPDATE geo.cities SET status = 'PAUSED' WHERE id = $1", [CITY.id]);
    expect(await check()).toBe(false);
    await h.db.migrator.query("UPDATE geo.cities SET status = 'PILOT' WHERE id = $1", [CITY.id]);
    await h.db.migrator.query("UPDATE geo.zones SET status = 'INACTIVE' WHERE id = $1", [loc.zoneId]);
    expect(await check()).toBe(false);
    await h.db.migrator.query("UPDATE geo.zones SET status = 'ACTIVE' WHERE id = $1", [loc.zoneId]);
    await h.db.migrator.query("UPDATE geo.localities SET status = 'INACTIVE' WHERE id = $1", [loc.id]);
    expect(await check()).toBe(false);
    expect((await search('Test Nagar 8', 'en-IN')).items.map((i) => i.id)).not.toContain(loc.id);
    await h.db.migrator.query("UPDATE geo.localities SET status = 'ACTIVE' WHERE id = $1", [loc.id]);
    expect(await check()).toBe(true);
  });

  it('zone of a locality and shortest travel over the adjacency graph (across zones via the one link)', async () => {
    expect(await h.api.geo.zoneOf(localityByCode('LOC-07').id)).toBe(localityByCode('LOC-07').zoneId);
    const minutes = (a: number, b: number) => kurnool.must(ADJACENCY.find((e) => e.from === localityByCode(`LOC-0${a}`).id && e.to === localityByCode(`LOC-0${b}`).id), 'edge').minutes;
    expect(await h.api.geo.travelEstimate(localityByCode('LOC-01').id, localityByCode('LOC-03').id)).toEqual({ minutes: minutes(1, 2) + minutes(2, 3), hops: 2 });
    expect((await h.api.geo.travelEstimate(localityByCode('LOC-05').id, localityByCode('LOC-08').id))?.hops).toBe(3);
    expect(await h.api.geo.travelEstimate(localityByCode('LOC-04').id, localityByCode('LOC-04').id)).toEqual({ minutes: 0, hops: 0 });
    expect(await h.api.geo.travelEstimate(localityByCode('LOC-04').id, newId())).toBeNull();
  });
});
