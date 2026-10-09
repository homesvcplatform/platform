// Two-person approved change of a city's languages (founder decisions §9.2, ADR-025 #4–#6): pricing admin proposes
// (`locales.enable`), city manager approves (`locales.approve`). Every newly added locale must pass the enablement
// gate, at proposal and again at execution (fail closed). The first locale is the city's primary locale (X-05).
import type pg from 'pg';
import { z } from 'zod';
import { appendAudit, withTransaction } from '@hsp/db';
import { AppError } from '@hsp/errors';
import { checkCatalogs, evaluateLocaleEnablement, isRegisteredLocale, loadRepositoryCatalogs, type CatalogIssue } from '@hsp/localization';
import { SQL } from '../infrastructure/sql.ts';

const input = z.strictObject({
  cityId: z.uuid(),
  supportedLocales: z.array(z.string().regex(/^[a-z]{2}-[A-Z]{2}$/)).min(1).max(8),
});

type Payload = { cityId: string; supportedLocales: string[]; expectedVersion: number };

const fail = (fields: { path: string; code: string }[]): never => {
  throw new AppError('VALIDATION_FAILED', { fields });
};

/** Repository catalog problems (missing / extra / empty keys, syntax, arguments): what the UI_CATALOG check uses. */
export function repositoryCatalogIssues(): CatalogIssue[] {
  const { catalogs, issues } = loadRepositoryCatalogs();
  return [...issues, ...checkCatalogs(catalogs)];
}

export function cityLocalesChangeAction(deps: {
  readonly pool: pg.Pool;
  readonly appEnv: string;
  /** Catalog issues source; defaults to the repository catalogs (tests inject a broken set). */
  readonly catalogIssues?: () => readonly CatalogIssue[];
}) {
  const issues = deps.catalogIssues ?? repositoryCatalogIssues;
  const blockers = (added: readonly string[]) => {
    const found = issues();
    return added.flatMap((locale) => evaluateLocaleEnablement({ locale, appEnv: deps.appEnv, catalogIssues: found }).blockers
      .map((b) => ({ path: `change.supportedLocales.${locale}`, code: b.requirement })));
  };

  return {
    actionType: 'geo.city.locales.set',
    resourceType: 'geo.city',
    makerPermission: 'locales.enable',
    checkerPermission: 'locales.approve',
    riskLevel: 'MEDIUM' as const,

    async prepare(raw: unknown) {
      const r = input.safeParse(raw);
      if (!r.success) fail(r.error.issues.slice(0, 10).map((i) => ({ path: `change.${i.path.join('.')}`, code: i.code.toUpperCase() })));
      const change = r.data as z.infer<typeof input>;
      if (new Set(change.supportedLocales).size !== change.supportedLocales.length) fail([{ path: 'change.supportedLocales', code: 'DUPLICATE' }]);
      const unregistered = change.supportedLocales.filter((l) => !isRegisteredLocale(l));
      if (unregistered.length > 0) fail(unregistered.map((l) => ({ path: `change.supportedLocales.${l}`, code: 'LOCALE_REGISTERED' })));
      const city = (await deps.pool.query(SQL.city, [change.cityId])).rows[0] as Record<string, unknown> | undefined;
      if (!city) fail([{ path: 'change.cityId', code: 'NOT_FOUND' }]);
      const current = (city?.['supported_locales'] as string[] | undefined) ?? [];
      if (current.join(',') === change.supportedLocales.join(',')) fail([{ path: 'change.supportedLocales', code: 'NO_CHANGE' }]);
      const added = change.supportedLocales.filter((l) => !current.includes(l));
      const blocked = blockers(added);
      if (blocked.length > 0) fail(blocked);
      const payload: Payload = { cityId: change.cityId, supportedLocales: change.supportedLocales, expectedVersion: city?.['version'] as number };
      return { payload, resourceId: change.cityId, cityId: change.cityId,
        summary: { supportedLocales: change.supportedLocales, addedCount: added.length, removedCount: current.filter((l) => !change.supportedLocales.includes(l)).length } };
    },

    cityOf(payload: Readonly<Record<string, unknown>>): string | null {
      return typeof payload['cityId'] === 'string' ? payload['cityId'] : null;
    },

    /** Idempotent: an already-applied list is a no-op; a city changed since the proposal refuses (stale approval). */
    async execute(changeRequestId: string, stored: Readonly<Record<string, unknown>>, ctx: { now: Date; actorId: string; requestId: string }) {
      const p = stored as Payload;
      await withTransaction(deps.pool, async (c) => {
        const city = (await c.query(SQL.lockCity, [p.cityId])).rows[0] as Record<string, unknown> | undefined;
        if (!city) throw new AppError('INVALID_STATE');
        const current = city['supported_locales'] as string[];
        if (current.join(',') === p.supportedLocales.join(',')) return;
        if (city['version'] !== p.expectedVersion) throw new AppError('INVALID_STATE');
        if (blockers(p.supportedLocales.filter((l) => !current.includes(l))).length > 0) throw new AppError('INVALID_STATE');
        await c.query(SQL.setCityLocales, [p.cityId, p.supportedLocales, p.expectedVersion]);
        await appendAudit(c, { actorType: 'ADMIN', actorId: ctx.actorId, action: 'geo.city_locales_changed', resourceType: 'geo.city',
          resourceId: p.cityId, cityId: p.cityId, outcome: 'SUCCESS', requestId: ctx.requestId,
          changeSummary: { changeRequestId, supportedLocales: p.supportedLocales } });
      });
    },
  };
}
