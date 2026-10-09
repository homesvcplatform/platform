// catalog application service (Phase 1 01 §4.2 catalog, 03 §8.1, 04 §6, ADR-020, ADR-025 #7–#8): what a city offers
// is data. A service type is listed for a city when it and its category are ACTIVE and its effective rule for that
// city has `enabled = true`; enabling or disabling is a rule change, never a deploy.
import type pg from 'pg';
import type { Clock } from '@hsp/kernel';
import { AppError } from '@hsp/errors';
import { localizedName, resolveLocale, type LocaleCode } from '@hsp/localization';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry } from '@hsp/policy';
import { RATE_RULES, type RateLimiter } from '@hsp/security';
import { effectiveRule, parseServiceRules, type ServiceRules } from '../domain/rules.ts';
import { SQL } from '../infrastructure/sql.ts';

/** City lookup port (implemented by geo, wired by the app): the city's offered locales. Catalog has no module dependencies. */
export interface CityDirectory {
  getCity(cityId: string): Promise<{ readonly supportedLocales: readonly string[] } | null>;
}

export interface CatalogDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policies: PolicyRegistry;
  readonly rateLimiter: RateLimiter;
  readonly cities: CityDirectory;
}

export interface PublicRequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
}

export interface RepairItem {
  readonly id: string;
  readonly code: string;
  readonly keypadCode: string | null;
  readonly names: unknown;
  readonly requiredServiceTypeId: string;
  readonly requiredSpecializationId: string | null;
  readonly warrantyPolicyCode: string | null;
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const repairItem = (r: Row): RepairItem => ({
  id: r['id'] as string, code: r['code'] as string, keypadCode: (r['keypad_code'] as string | null) ?? null, names: r['names'],
  requiredServiceTypeId: r['required_service_type_id'] as string, requiredSpecializationId: (r['required_specialization_id'] as string | null) ?? null,
  warrantyPolicyCode: (r['warranty_policy_code'] as string | null) ?? null,
});

export class CatalogService {
  readonly #d: CatalogDeps;

  constructor(deps: CatalogDeps) {
    this.#d = deps;
  }

  #require(actor: Actor, action: string): void {
    const d = this.#d.policies.can(actor, action, {}, { now: this.#d.clock.now() });
    if (!d.allow) throw new AppError('FORBIDDEN');
  }

  async #limit(meta: PublicRequestMeta): Promise<void> {
    const r = await this.#d.rateLimiter.consume([{ rule: RATE_RULES.publicRead, key: meta.clientIp }], this.#d.clock.now());
    if (!r.allowed) throw new AppError('RATE_LIMITED', { retryAfterSec: r.retryAfterSec });
  }

  /** Parses a stored rule; an invalid rule never enables anything (fail closed) and is reported. */
  #rules(value: unknown, serviceTypeId: string): ServiceRules | undefined {
    const parsed = parseServiceRules(value);
    if (parsed.ok) return parsed.rules;
    this.#d.logger.log('warn', 'catalog.invalid_service_rule', { serviceTypeId, issueCount: parsed.issues.length });
    return undefined;
  }

  async #cityLocale(cityId: string, requested: string | undefined): Promise<LocaleCode> {
    const city = await this.#d.cities.getCity(cityId);
    if (!city) throw new AppError('NOT_FOUND');
    return resolveLocale(requested, city.supportedLocales);
  }

  #countFallbacks(locale: LocaleCode, count: number, surface: string): void {
    if (count > 0) this.#d.logger.log('info', 'i18n.fallback', { locale, fallbackCount: count, surface });
  }

  /** GET /v1/catalog/categories: categories with the service types offered in the city now. */
  async listCategories(actor: Actor, input: { cityId: string; locale?: string | undefined }, meta: PublicRequestMeta) {
    this.#require(actor, 'catalog.categories.list');
    await this.#limit(meta);
    const locale = await this.#cityLocale(input.cityId, input.locale);
    const rows = (await this.#d.pool.query(SQL.offeredTypes, [input.cityId, this.#d.clock.now()])).rows as Row[];
    const categories = new Map<string, { id: string; code: string; label: string; iconUrl: null; serviceTypes: { id: string; code: string; label: string; iconUrl: null }[] }>();
    let fallbacks = 0;
    for (const r of rows) {
      if (this.#rules(r['rules'], r['id'] as string)?.enabled !== true) continue;
      const categoryId = r['category_id'] as string;
      let category = categories.get(categoryId);
      if (!category) {
        const label = localizedName(r['category_names'], locale);
        fallbacks += Number(label.fellBack);
        category = { id: categoryId, code: r['category_code'] as string, label: label.text, iconUrl: null, serviceTypes: [] };
        categories.set(categoryId, category);
      }
      const label = localizedName(r['names'], locale);
      fallbacks += Number(label.fellBack);
      category.serviceTypes.push({ id: r['id'] as string, code: r['code'] as string, label: label.text, iconUrl: null });
    }
    this.#countFallbacks(locale, fallbacks, 'catalog.categories');
    return { locale, categories: [...categories.values()] };
  }

  /** GET /v1/catalog/service-types/{id}/symptoms: only for a service type offered in the city (else 404). */
  async listSymptoms(actor: Actor, input: { serviceTypeId: string; cityId: string; locale?: string | undefined }, meta: PublicRequestMeta) {
    this.#require(actor, 'catalog.symptoms.list');
    await this.#limit(meta);
    const locale = await this.#cityLocale(input.cityId, input.locale);
    if (!(await this.isOffered(input.serviceTypeId, input.cityId))) throw new AppError('NOT_FOUND');
    const rows = (await this.#d.pool.query(SQL.symptoms, [input.serviceTypeId])).rows as Row[];
    let fallbacks = 0;
    const items = rows.map((r) => {
      const label = localizedName(r['names'], locale);
      fallbacks += Number(label.fellBack);
      return { code: r['code'] as string, label: label.text, iconUrl: null };
    });
    this.#countFallbacks(locale, fallbacks, 'catalog.symptoms');
    return { locale, items };
  }

  // ---------------------------------------------------------------- facade (01 §4.2)

  async getServiceType(serviceTypeId: string): Promise<{ id: string; code: string; names: unknown; active: boolean } | null> {
    if (!UUID.test(serviceTypeId)) return null;
    const r = (await this.#d.pool.query(SQL.serviceType, [serviceTypeId])).rows[0] as Row | undefined;
    return r ? { id: r['id'] as string, code: r['code'] as string, names: r['names'], active: r['status'] === 'ACTIVE' && r['category_status'] === 'ACTIVE' } : null;
  }

  /** The effective, validated rules for a service type in a city at a time (city rule, else default). */
  async getServiceRules(serviceTypeId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<ServiceRules | null> {
    if (!UUID.test(serviceTypeId) || !UUID.test(cityId)) return null;
    const rows = (await this.#d.pool.query(SQL.effectiveRule, [serviceTypeId, cityId, at])).rows as Row[];
    const city = rows.find((r) => r['city_id'] !== null);
    const fallback = rows.find((r) => r['city_id'] === null);
    const row = effectiveRule(city, fallback);
    return row ? (this.#rules(row['rules'], serviceTypeId) ?? null) : null;
  }

  /** Offered = the service type and its category are ACTIVE and the effective rule enables it in the city. */
  async isOffered(serviceTypeId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<boolean> {
    const type = await this.getServiceType(serviceTypeId);
    if (!type?.active) return false;
    return (await this.getServiceRules(serviceTypeId, cityId, at))?.enabled === true;
  }

  async getRepairItems(serviceTypeId: string): Promise<RepairItem[]> {
    if (!UUID.test(serviceTypeId)) return [];
    return ((await this.#d.pool.query(SQL.repairItems, [serviceTypeId])).rows as Row[]).map(repairItem);
  }

  /** IVR keypad resolution within the visit's service type (ADR-020). */
  async resolveKeypadCode(serviceTypeId: string, keypadCode: string): Promise<RepairItem | null> {
    if (!UUID.test(serviceTypeId) || !/^[0-9]{2,3}$/.test(keypadCode)) return null;
    const r = (await this.#d.pool.query(SQL.repairItemByKeypad, [serviceTypeId, keypadCode])).rows[0] as Row | undefined;
    return r ? repairItem(r) : null;
  }

  /** Reference price of a material in a city at a time (paise per unit), or null. */
  async getMaterialReference(materialId: string, cityId: string, at: Date = this.#d.clock.now()): Promise<{ unitPricePaise: bigint; unit: string } | null> {
    if (!UUID.test(materialId) || !UUID.test(cityId)) return null;
    const r = (await this.#d.pool.query(SQL.materialReference, [materialId, cityId, at])).rows[0] as Row | undefined;
    return r ? { unitPricePaise: BigInt(r['unit_price_paise'] as string), unit: r['unit'] as string } : null;
  }
}
