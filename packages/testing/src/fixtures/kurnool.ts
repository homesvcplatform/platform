// Synthetic Kurnool pilot fixtures (Phase 2 05 §1). Fictional places, people and phone numbers; fixture prices are
// TEST VALUES ONLY and are labelled NOT FINAL (Phase 2 01 §7: no final pricing values in code or migrations).
import { fixtureId } from '@hsp/kernel';

export const FIXTURE_EPOCH = '2026-01-01T00:00:00Z';
const id = (ns: string, name: string) => fixtureId(ns, name);

/** Returns `value`, or throws naming `what` (fixtures are static, so a miss is a programming error). */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture lookup failed: ${what}`);
  return value;
}

export const ADMINS = {
  maker: id('admin', 'FIXTURE-ADMIN-MAKER'),
  checker: id('admin', 'FIXTURE-ADMIN-CHECKER'),
} as const;

export const CITY = {
  id: id('geo.cities', 'KNL'),
  code: 'KNL',
  names: { en: 'Kurnool (synthetic test city)', te: 'కర్నూలు (పరీక్ష నగరం)' },
  stateCode: 'IN-AP',
  locales: ['te-IN', 'en-IN'],
  status: 'PILOT',
} as const;

/** Two synthetic zones as rectangles (lon/lat), split at latitude 15.830. */
export const ZONES = [
  { code: 'Z-NORTH', names: { en: 'North test zone', te: 'ఉత్తర పరీక్ష జోన్' }, box: [78.0, 15.83, 78.1, 15.87] },
  { code: 'Z-SOUTH', names: { en: 'South test zone', te: 'దక్షిణ పరీక్ష జోన్' }, box: [78.0, 15.79, 78.1, 15.83] },
].map((z) => ({ ...z, id: id('geo.zones', z.code) }));

/** 12 fictional localities, 6 per zone, with centroids inside their zone. */
export const LOCALITIES = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  const zone = must(ZONES[n <= 6 ? 0 : 1], 'zone');
  const k = (n - 1) % 6;
  const lon = 78.01 + k * 0.015;
  const lat = zone.code === 'Z-NORTH' ? 15.85 : 15.81;
  const code = `LOC-${String(n).padStart(2, '0')}`;
  return {
    id: id('geo.localities', code),
    code,
    zoneId: zone.id,
    names: { en: `Test Nagar ${n}`, te: `టెస్ట్ నగర్ ${n}` },
    lon,
    lat,
  };
});

/** Fictional local-language and colloquial aliases for locality search (Gate 4). `normalized` follows the geo module rule. */
export const LOCALITY_ALIASES = [
  { locality: 'LOC-05', alias: 'Railway Colony (test)', script: 'Latn' },
  { locality: 'LOC-05', alias: 'రైల్వే కాలనీ', script: 'Telu' },
  { locality: 'LOC-09', alias: 'Old Market (test)', script: 'Latn' },
  { locality: 'LOC-09', alias: 'పాత మార్కెట్', script: 'Telu' },
].map((a) => ({ ...a, normalized: a.alias.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim() }));

/** Adjacency: a chain inside each zone plus one cross-zone link (LOC-06 <-> LOC-07), both directions. */
export const ADJACENCY = (() => {
  const edges: { from: string; to: string; minutes: number }[] = [];
  const link = (a: number, b: number, minutes: number) => {
    const from = must(LOCALITIES[a - 1], `locality ${a}`).id;
    const to = must(LOCALITIES[b - 1], `locality ${b}`).id;
    edges.push({ from, to, minutes }, { from: to, to: from, minutes });
  };
  for (let n = 1; n < 12; n += 1) if (n !== 6) link(n, n + 1, 10 + (n % 3) * 5);
  link(6, 7, 20);
  return edges;
})();

export interface ServiceTypeFixture {
  code: string;
  category: string;
  names: { en: string; te: string };
  specializations: string[];
  /** Bookable in the synthetic city (service_rules.rules.enabled). */
  enabledInCity: boolean;
}

export const CATEGORIES = [
  { code: 'PLUMBING', names: { en: 'Plumbing', te: 'ప్లంబింగ్' } },
  { code: 'ELECTRICAL', names: { en: 'Electrical', te: 'ఎలక్ట్రికల్' } },
  { code: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Appliance & Home Equipment', te: 'గృహోపకరణాలు' } },
].map((c, i) => ({ ...c, id: id('catalog.service_categories', c.code), sortOrder: i + 1 }));

/** Phase 1 03 §8.1 tree; enablement per Phase 2 05 §1 (AC enabled in the test city only, for the regression scenario). */
export const SERVICE_TYPES: (ServiceTypeFixture & { id: string })[] = (
  [
    { code: 'PLUMBING_GENERAL', category: 'PLUMBING', names: { en: 'Plumbing', te: 'ప్లంబింగ్' }, specializations: ['LEAKAGE', 'DRAINAGE_BLOCKAGE', 'FITTINGS'], enabledInCity: true },
    { code: 'PLUMBING_TANK_MOTOR', category: 'PLUMBING', names: { en: 'Tank & motor', te: 'ట్యాంక్ & మోటార్' }, specializations: ['PUMP_CONNECTION'], enabledInCity: false },
    { code: 'ELECTRICAL_GENERAL', category: 'ELECTRICAL', names: { en: 'Electrical', te: 'ఎలక్ట్రికల్' }, specializations: ['WIRING', 'DISTRIBUTION_BOARD', 'FAN_LIGHT_FITTING', 'EARTHING'], enabledInCity: true },
    { code: 'REFRIGERATOR', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Refrigerator', te: 'రిఫ్రిజిరేటర్' }, specializations: ['COOLING', 'COMPRESSOR', 'THERMOSTAT', 'GAS_REFRIGERATION', 'ELECTRICAL'], enabledInCity: true },
    { code: 'RO_WATER_PURIFIER', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'RO water purifier', te: 'RO వాటర్ ప్యూరిఫైయర్' }, specializations: ['FILTER', 'PUMP', 'MEMBRANE', 'ELECTRICAL', 'LEAKAGE'], enabledInCity: true },
    { code: 'WASHING_MACHINE', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Washing machine', te: 'వాషింగ్ మెషిన్' }, specializations: ['DRAINAGE', 'MOTOR', 'PCB', 'INLET', 'ELECTRICAL'], enabledInCity: true },
    { code: 'GEYSER', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Geyser', te: 'గీజర్' }, specializations: ['HEATING_ELEMENT', 'THERMOSTAT', 'LEAKAGE', 'ELECTRICAL'], enabledInCity: true },
    { code: 'AIR_COOLER', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Air cooler', te: 'ఎయిర్ కూలర్' }, specializations: ['MOTOR_FAN', 'PUMP', 'ELECTRICAL', 'WATER_FLOW'], enabledInCity: true },
    { code: 'AC', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Air conditioner', te: 'ఏసీ' }, specializations: ['COOLING', 'ELECTRICAL', 'GAS_REFRIGERATION', 'PCB', 'COMPRESSOR'], enabledInCity: true },
    { code: 'INVERTER', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Inverter', te: 'ఇన్వర్టర్' }, specializations: ['BATTERY', 'PCB', 'WIRING'], enabledInCity: false },
    { code: 'MIXER_GRINDER', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Mixer grinder', te: 'మిక్సర్ గ్రైండర్' }, specializations: ['MOTOR', 'JAR_COUPLER', 'ELECTRICAL'], enabledInCity: false },
    { code: 'MICROWAVE', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'Microwave', te: 'మైక్రోవేవ్' }, specializations: ['MAGNETRON', 'PCB', 'ELECTRICAL'], enabledInCity: false },
    { code: 'TV', category: 'APPLIANCE_HOME_EQUIPMENT', names: { en: 'TV', te: 'టీవీ' }, specializations: ['PANEL_BACKLIGHT', 'PCB', 'POWER_SUPPLY'], enabledInCity: false },
  ] satisfies ServiceTypeFixture[]
).map((t) => ({ ...t, id: id('catalog.service_types', t.code) }));

export function serviceTypeId(code: string): string {
  const t = SERVICE_TYPES.find((s) => s.code === code);
  if (!t) throw new Error(`unknown service type ${code}`);
  return t.id;
}

export function specializationId(serviceType: string, code: string): string {
  return id('catalog.specializations', `${serviceType}/${code}`);
}

export const SYMPTOMS: { serviceType: string; code: string; en: string; te: string }[] = [
  { serviceType: 'PLUMBING_GENERAL', code: 'LEAK_UNDER_SINK', en: 'Leak under sink', te: 'సింక్ కింద లీక్' },
  { serviceType: 'PLUMBING_GENERAL', code: 'TAP_DRIPPING', en: 'Tap dripping', te: 'కుళాయి కారుతోంది' },
  { serviceType: 'ELECTRICAL_GENERAL', code: 'FREQUENT_TRIPPING', en: 'Frequent tripping', te: 'తరచుగా ట్రిప్ అవుతోంది' },
  { serviceType: 'REFRIGERATOR', code: 'NOT_COOLING', en: 'Not cooling', te: 'చల్లబడటం లేదు' },
  { serviceType: 'RO_WATER_PURIFIER', code: 'NO_WATER_FLOW', en: 'No water flow', te: 'నీరు రావడం లేదు' },
  { serviceType: 'WASHING_MACHINE', code: 'NOT_DRAINING', en: 'Not draining', te: 'నీరు బయటకు పోవడం లేదు' },
  { serviceType: 'GEYSER', code: 'NO_HOT_WATER', en: 'No hot water', te: 'వేడి నీరు రావడం లేదు' },
  { serviceType: 'AIR_COOLER', code: 'NOT_COOLING', en: 'Not cooling', te: 'చల్లబడటం లేదు' },
  { serviceType: 'AC', code: 'NOT_COOLING', en: 'Not cooling', te: 'చల్లబడటం లేదు' },
];

/** Gate 6 (ADR-027 #1): the problem taxonomy a diagnosis names, per service type (what the technician found). */
export const PROBLEMS: { serviceType: string; code: string; en: string }[] = [
  { serviceType: 'PLUMBING_GENERAL', code: 'TRAP_LEAK', en: 'Leaking sink trap' },
  { serviceType: 'PLUMBING_GENERAL', code: 'JOINT_LEAK', en: 'Leaking pipe joint' },
  { serviceType: 'PLUMBING_GENERAL', code: 'NO_FAULT_FOUND', en: 'No fault found' },
  { serviceType: 'ELECTRICAL_GENERAL', code: 'MCB_FAULT', en: 'Faulty MCB' },
  { serviceType: 'ELECTRICAL_GENERAL', code: 'SWITCH_FAULT', en: 'Faulty switch' },
  { serviceType: 'ELECTRICAL_GENERAL', code: 'NO_FAULT_FOUND', en: 'No fault found' },
  { serviceType: 'REFRIGERATOR', code: 'THERMOSTAT_FAULT', en: 'Thermostat fault' },
  { serviceType: 'REFRIGERATOR', code: 'REFRIGERANT_LEAK', en: 'Refrigerant leak' },
  { serviceType: 'REFRIGERATOR', code: 'COMPRESSOR_FAILURE', en: 'Compressor failure' },
  { serviceType: 'REFRIGERATOR', code: 'NO_FAULT_FOUND', en: 'No fault found' },
  { serviceType: 'RO_WATER_PURIFIER', code: 'FILTER_CLOGGED', en: 'Clogged filters' },
  { serviceType: 'RO_WATER_PURIFIER', code: 'MEMBRANE_FAULT', en: 'Membrane fault' },
  { serviceType: 'WASHING_MACHINE', code: 'DRAIN_PUMP_FAULT', en: 'Drain pump fault' },
  { serviceType: 'GEYSER', code: 'HEATING_ELEMENT_FAILURE', en: 'Heating element failure' },
  { serviceType: 'AIR_COOLER', code: 'PUMP_FAILURE', en: 'Pump failure' },
  { serviceType: 'AC', code: 'CAPACITOR_FAILURE', en: 'Capacitor failure' },
  { serviceType: 'AC', code: 'WIRING_DAMAGE', en: 'Indoor wiring damage' },
  { serviceType: 'AC', code: 'NO_FAULT_FOUND', en: 'No fault found' },
];

/** Keypad codes are service-type-specific (ADR-020): 21 under REFRIGERATOR is not 21 under RO_WATER_PURIFIER. */
export const REPAIR_ITEMS: { code: string; serviceType: string; keypad: string; specialization: string | null; en: string }[] = [
  { code: 'REP-PLB-TRAP-REPLACE', serviceType: 'PLUMBING_GENERAL', keypad: '11', specialization: 'LEAKAGE', en: 'Replace sink trap' },
  { code: 'REP-PLB-JOINT-RESEAL', serviceType: 'PLUMBING_GENERAL', keypad: '12', specialization: 'LEAKAGE', en: 'Reseal pipe joint' },
  { code: 'REP-ELE-MCB-REPLACE', serviceType: 'ELECTRICAL_GENERAL', keypad: '11', specialization: 'DISTRIBUTION_BOARD', en: 'Replace MCB' },
  { code: 'REP-ELE-SWITCH-REPLACE', serviceType: 'ELECTRICAL_GENERAL', keypad: '12', specialization: null, en: 'Replace switch' },
  { code: 'REP-FRIDGE-THERMOSTAT-REPLACE', serviceType: 'REFRIGERATOR', keypad: '21', specialization: 'THERMOSTAT', en: 'Replace thermostat' },
  { code: 'REP-FRIDGE-GAS-CHARGE', serviceType: 'REFRIGERATOR', keypad: '22', specialization: 'GAS_REFRIGERATION', en: 'Gas charge' },
  { code: 'REP-FRIDGE-LEAK-FIX', serviceType: 'REFRIGERATOR', keypad: '23', specialization: 'GAS_REFRIGERATION', en: 'Fix refrigerant leak' },
  { code: 'REP-RO-FILTER-SET-REPLACE', serviceType: 'RO_WATER_PURIFIER', keypad: '21', specialization: 'FILTER', en: 'Replace filter set' },
  { code: 'REP-RO-MEMBRANE-REPLACE', serviceType: 'RO_WATER_PURIFIER', keypad: '22', specialization: 'MEMBRANE', en: 'Replace membrane' },
  { code: 'REP-WM-DRAIN-PUMP-REPLACE', serviceType: 'WASHING_MACHINE', keypad: '21', specialization: 'DRAINAGE', en: 'Replace drain pump' },
  { code: 'REP-GEYSER-ELEMENT-REPLACE', serviceType: 'GEYSER', keypad: '21', specialization: 'HEATING_ELEMENT', en: 'Replace heating element' },
  { code: 'REP-COOLER-PUMP-REPLACE', serviceType: 'AIR_COOLER', keypad: '21', specialization: 'PUMP', en: 'Replace cooler pump' },
  { code: 'REP-AC-CAPACITOR-REPLACE', serviceType: 'AC', keypad: '21', specialization: 'ELECTRICAL', en: 'Replace capacitor' },
  { code: 'REP-AC-WIRING-INDOOR', serviceType: 'AC', keypad: '22', specialization: 'ELECTRICAL', en: 'Indoor wiring repair' },
];

export const MATERIALS: { code: string; unit: 'PIECE' | 'METRE' | 'LITRE' | 'KG' | 'SET'; en: string; testPricePaise: number }[] = [
  { code: 'MAT-PVC-SINK-TRAP', unit: 'PIECE', en: 'PVC sink trap', testPricePaise: 25000 },
  { code: 'MAT-PIPE-JOINT-KIT', unit: 'SET', en: 'Pipe joint kit', testPricePaise: 12000 },
  { code: 'MAT-MCB-16A', unit: 'PIECE', en: 'MCB 16A', testPricePaise: 30000 },
  { code: 'MAT-FRIDGE-THERMOSTAT', unit: 'PIECE', en: 'Refrigerator thermostat', testPricePaise: 60000 },
  { code: 'MAT-REFRIGERANT-R600A', unit: 'KG', en: 'Refrigerant R600a', testPricePaise: 90000 },
  { code: 'MAT-RO-FILTER-SET', unit: 'SET', en: 'RO filter set', testPricePaise: 80000 },
  { code: 'MAT-AC-CAPACITOR', unit: 'PIECE', en: 'AC capacitor', testPricePaise: 45000 },
];

/**
 * Two fixture rate cards: Model B (ACTIVE) and Model C (DRAFT), Phase 1.1 06 §1.3. TEST VALUES ONLY, NOT FINAL. Gate 6
 * (ADR-027 #4): Model B has no visit-fee credit and no platform fee; Model C credits 50 % and adds a flat platform fee.
 */
export const RATE_CARDS = [
  { label: 'MODEL_B_FIXTURE_NOT_FINAL', versionNo: 1, status: 'ACTIVE', visitFeePaise: 19900, labourBasePaise: 30000, shareBps: 7500,
    visitFeeCreditBps: 0, platformFeePaise: 0, diagnosisPayoutPaise: 7000 },
  { label: 'MODEL_C_FIXTURE_NOT_FINAL', versionNo: 2, status: 'DRAFT', visitFeePaise: 14900, labourBasePaise: 35000, shareBps: 8000,
    visitFeeCreditBps: 5000, platformFeePaise: 2900, diagnosisPayoutPaise: 10000 },
].map((c) => ({ ...c, id: id('pricing.rate_cards', c.label) }));

export interface TechnicianFixture {
  key: string;
  phone: string;
  displayName: string;
  deviceMode: 'SMARTPHONE' | 'BASIC_PHONE';
  homeLocality: string;
  serviceType: string;
  /** Specializations held in addition to the base (unspecialised) skill. */
  specializations: string[];
  level: 'ASSESSED' | 'CERTIFIED';
}

export const TECHNICIANS: (TechnicianFixture & { userId: string })[] = (
  [
    { key: 'T-PLB-1', phone: '+910000000101', displayName: 'Test Plumber One', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-02', serviceType: 'PLUMBING_GENERAL', specializations: ['LEAKAGE'], level: 'ASSESSED' },
    { key: 'T-PLB-2', phone: '+910000000102', displayName: 'Test Plumber Two', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-08', serviceType: 'PLUMBING_GENERAL', specializations: ['LEAKAGE', 'DRAINAGE_BLOCKAGE'], level: 'ASSESSED' },
    { key: 'T-ELE-1', phone: '+910000000103', displayName: 'Test Electrician One', deviceMode: 'BASIC_PHONE', homeLocality: 'LOC-04', serviceType: 'ELECTRICAL_GENERAL', specializations: ['DISTRIBUTION_BOARD', 'WIRING'], level: 'ASSESSED' },
    { key: 'T-FRG-1', phone: '+910000000104', displayName: 'Test Fridge Tech One', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-05', serviceType: 'REFRIGERATOR', specializations: ['COOLING', 'THERMOSTAT'], level: 'ASSESSED' },
    { key: 'T-FRG-2', phone: '+910000000105', displayName: 'Test Fridge Specialist', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-09', serviceType: 'REFRIGERATOR', specializations: ['GAS_REFRIGERATION'], level: 'ASSESSED' },
    { key: 'T-RO-1', phone: '+910000000106', displayName: 'Test RO Tech One', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-06', serviceType: 'RO_WATER_PURIFIER', specializations: ['FILTER'], level: 'ASSESSED' },
    { key: 'T-AC-1', phone: '+910000000107', displayName: 'Test AC Tech One', deviceMode: 'SMARTPHONE', homeLocality: 'LOC-10', serviceType: 'AC', specializations: ['COOLING', 'ELECTRICAL'], level: 'ASSESSED' },
  ] satisfies TechnicianFixture[]
).map((t) => ({ ...t, userId: id('identity.users', t.key) }));

export const CUSTOMERS = [
  { key: 'C-1', phone: '+910000000201', locale: 'te-IN', language: 'te', locality: 'LOC-03', line1: 'House 1, Test Street A', landmark: 'Near synthetic water tank' },
  { key: 'C-2', phone: '+910000000202', locale: 'te-IN', language: 'te', locality: 'LOC-04', line1: 'House 2, Test Street B', landmark: 'Opposite test school' },
  { key: 'C-3', phone: '+910000000203', locale: 'en-IN', language: 'en', locality: 'LOC-09', line1: 'Flat 3, Test Residency', landmark: 'Behind test temple' },
  { key: 'C-4', phone: '+910000000204', locale: 'en-IN', language: 'en', locality: 'LOC-11', line1: 'House 4, Test Layout', landmark: 'Next to test park' },
].map((c) => ({ ...c, userId: id('identity.users', c.key), addressId: id('customers.addresses', c.key) }));

/** Per repair item warranty fixtures (gas charge vs leak fix get different terms). */
export function warrantyDays(repairItemCode: string): number {
  if (repairItemCode === 'REP-FRIDGE-GAS-CHARGE') return 30;
  if (repairItemCode === 'REP-FRIDGE-LEAK-FIX') return 90;
  return 30;
}

export function localityByCode(code: string) {
  const l = LOCALITIES.find((x) => x.code === code);
  if (!l) throw new Error(`unknown locality ${code}`);
  return l;
}

export { id as fixtureRowId };
