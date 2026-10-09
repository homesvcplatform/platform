// geo application service (Phase 1 01 §4.2 geo, 04 §5, ADR-025 #9): locality search, serviceability, zone and
// travel estimates over synthetic reference data. No geocoding provider in Gate 4.
import type pg from 'pg';
import type { Clock } from '@hsp/kernel';
import { AppError } from '@hsp/errors';
import { localizedName, resolveLocale, type LocaleCode } from '@hsp/localization';
import type { Logger } from '@hsp/observability';
import type { Actor, PolicyRegistry } from '@hsp/policy';
import { RATE_RULES, type RateLimiter } from '@hsp/security';
import { isInIndia, normalizeSearchText, shortestTravel } from '../domain/geo.ts';
import { SQL } from '../infrastructure/sql.ts';

export interface GeoDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policies: PolicyRegistry;
  readonly rateLimiter: RateLimiter;
  /** Deployment environment (locale enablement fails closed outside local / test, ADR-025 #4). */
  readonly appEnv: string;
}

export interface PublicRequestMeta {
  readonly requestId: string;
  readonly clientIp: string;
}

export interface City {
  readonly id: string;
  readonly code: string;
  readonly supportedLocales: readonly string[];
  readonly status: 'PLANNED' | 'PILOT' | 'LIVE' | 'PAUSED';
  readonly version: number;
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class GeoService {
  readonly #d: GeoDeps;

  constructor(deps: GeoDeps) {
    this.#d = deps;
  }

  get appEnv(): string {
    return this.#d.appEnv;
  }

  #require(actor: Actor, action: string): void {
    const d = this.#d.policies.can(actor, action, {}, { now: this.#d.clock.now() });
    if (!d.allow) throw new AppError('FORBIDDEN');
  }

  async #limit(meta: PublicRequestMeta): Promise<void> {
    const r = await this.#d.rateLimiter.consume([{ rule: RATE_RULES.publicRead, key: meta.clientIp }], this.#d.clock.now());
    if (!r.allowed) throw new AppError('RATE_LIMITED', { retryAfterSec: r.retryAfterSec });
  }

  async getCity(cityId: string): Promise<City | null> {
    if (!UUID.test(cityId)) return null;
    const r = (await this.#d.pool.query(SQL.city, [cityId])).rows[0] as Row | undefined;
    return r ? { id: r['id'] as string, code: r['code'] as string, supportedLocales: r['supported_locales'] as string[],
      status: r['status'] as City['status'], version: r['version'] as number } : null;
  }

  /** GET /v1/geo/localities: at most 20 active localities of the city matching the text (names and aliases). */
  async searchLocalities(actor: Actor, input: { cityId: string; q: string; locale?: string | undefined }, meta: PublicRequestMeta):
    Promise<{ locale: LocaleCode; items: { id: string; name: string; zoneName: string; isServiceable: boolean }[] }> {
    this.#require(actor, 'geo.localities.search');
    await this.#limit(meta);
    const city = await this.getCity(input.cityId);
    const locale = resolveLocale(input.locale, city?.supportedLocales);
    const q = normalizeSearchText(input.q);
    if (!city || q.length < 2) return { locale, items: [] };
    const rows = (await this.#d.pool.query(SQL.searchLocalities, [city.id, q])).rows as Row[];
    let fallbacks = 0;
    const items = rows.map((r) => {
      const name = localizedName(r['names'], locale);
      const zone = localizedName(r['zone_names'], locale);
      fallbacks += Number(name.fellBack) + Number(zone.fellBack);
      return { id: r['id'] as string, name: name.text, zoneName: zone.text, isServiceable: r['serviceable'] === true };
    });
    if (fallbacks > 0) this.#d.logger.log('info', 'i18n.fallback', { locale, fallbackCount: fallbacks, surface: 'geo.localities' });
    return { locale, items };
  }

  /** POST /v1/geo/serviceability: by point (inside India) or by locality. Unknown or unserved → `serviceable: false`. */
  async checkServiceability(actor: Actor, input: { point: { lat: number; lng: number } } | { localityId: string }, meta: PublicRequestMeta):
    Promise<{ serviceable: boolean; cityId?: string; localityId?: string }> {
    this.#require(actor, 'geo.serviceability.check');
    await this.#limit(meta);
    if ('localityId' in input) {
      const r = UUID.test(input.localityId) ? ((await this.#d.pool.query(SQL.localityServiceability, [input.localityId])).rows[0] as Row | undefined) : undefined;
      return r ? { serviceable: r['serviceable'] === true, cityId: r['city_id'] as string, localityId: r['id'] as string } : { serviceable: false };
    }
    if (!isInIndia(input.point)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'point', code: 'OUTSIDE_INDIA' }] });
    const r = (await this.#d.pool.query(SQL.pointServiceability, [input.point.lat, input.point.lng])).rows[0] as Row | undefined;
    if (!r || r['locality_id'] === null) return { serviceable: false };
    return { serviceable: r['city_status'] === 'PILOT' || r['city_status'] === 'LIVE', cityId: r['city_id'] as string, localityId: r['locality_id'] as string };
  }

  /** Facade (customers port): city, zone and serviceability of a locality. */
  async locality(localityId: string): Promise<{ cityId: string; zoneId: string; serviceable: boolean } | null> {
    if (!UUID.test(localityId)) return null;
    const r = (await this.#d.pool.query(SQL.localityServiceability, [localityId])).rows[0] as Row | undefined;
    return r ? { cityId: r['city_id'] as string, zoneId: r['zone_id'] as string, serviceable: r['serviceable'] === true } : null;
  }

  /** Facade (jobs port): metres from a locality's centroid to a point (wait evidence), null when unknown. */
  async metresFromLocality(localityId: string, point: { lat: number; lng: number }): Promise<number | null> {
    if (!UUID.test(localityId) || !isInIndia(point)) return null;
    const r = (await this.#d.pool.query(SQL.localityDistance, [localityId, point.lat, point.lng])).rows[0] as Row | undefined;
    return r ? Number(r['metres']) : null;
  }

  /** Facade: the zone of a locality (null when unknown). */
  async zoneOf(localityId: string): Promise<string | null> {
    if (!UUID.test(localityId)) return null;
    const r = (await this.#d.pool.query(SQL.zoneOf, [localityId])).rows[0] as Row | undefined;
    return (r?.['zone_id'] as string | undefined) ?? null;
  }

  /** Facade: typical travel time between two localities of one city (shortest path over the adjacency graph). */
  async travelEstimate(fromLocalityId: string, toLocalityId: string): Promise<{ minutes: number; hops: number } | null> {
    if (!UUID.test(fromLocalityId) || !UUID.test(toLocalityId)) return null;
    const rows = (await this.#d.pool.query(SQL.cityAdjacency, [fromLocalityId])).rows as Row[];
    return shortestTravel(rows.map((r) => ({ from: r['locality_id'] as string, to: r['neighbor_id'] as string, minutes: r['travel_minutes_typical'] as number })),
      fromLocalityId, toLocalityId);
  }
}
