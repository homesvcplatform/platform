// Two-person approved change of a city (or default) service rule (ADR-025 #5–#7, 05 §5.4): pricing admin proposes
// (`service_rules.edit`), city manager approves (`service_rules.approve`). Backoffice runs the maker-checker flow; this
// action validates the proposal and applies the approved payload once, in catalog's own transaction.
import type pg from 'pg';
import { z } from 'zod';
import { appendAudit, withTransaction } from '@hsp/db';
import { AppError } from '@hsp/errors';
import { newId } from '@hsp/kernel';
import { parseServiceRules } from '../domain/rules.ts';
import { SQL } from '../infrastructure/sql.ts';
import type { CityDirectory } from './service.ts';

const MAX_LEAD_MS = 366 * 24 * 3_600_000;

const input = z.strictObject({
  serviceTypeId: z.uuid(),
  /** null = the default rule for every city (needs GLOBAL grants). */
  cityId: z.uuid().nullable(),
  rules: z.unknown(),
  /** When the rule starts; omitted = when the approved change executes. */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

type Payload = { serviceTypeId: string; cityId: string | null; rules: Record<string, unknown>; effectiveFrom: string | null };

const fail = (fields: { path: string; code: string }[]): never => {
  throw new AppError('VALIDATION_FAILED', { fields });
};

export function serviceRulesChangeAction(deps: { readonly pool: pg.Pool; readonly cities: CityDirectory }) {
  return {
    actionType: 'catalog.service_rules.set',
    resourceType: 'catalog.service_type',
    makerPermission: 'service_rules.edit',
    checkerPermission: 'service_rules.approve',
    riskLevel: 'MEDIUM' as const,

    async prepare(raw: unknown, now: Date) {
      const r = input.safeParse(raw);
      if (!r.success) fail(r.error.issues.slice(0, 10).map((i) => ({ path: `change.${i.path.join('.')}`, code: i.code.toUpperCase() })));
      const change = r.data as z.infer<typeof input>;
      const rules = parseServiceRules(change.rules);
      if (!rules.ok) fail(rules.issues.map((i) => ({ path: `change.rules.${i.path}`, code: i.code })));
      const type = (await deps.pool.query(SQL.serviceType, [change.serviceTypeId])).rows[0];
      if (!type) fail([{ path: 'change.serviceTypeId', code: 'NOT_FOUND' }]);
      if (change.cityId !== null && !(await deps.cities.getCity(change.cityId))) fail([{ path: 'change.cityId', code: 'NOT_FOUND' }]);
      const from = change.effectiveFrom === undefined ? null : new Date(change.effectiveFrom);
      if (from && (from.getTime() < now.getTime() || from.getTime() > now.getTime() + MAX_LEAD_MS)) fail([{ path: 'change.effectiveFrom', code: 'OUT_OF_RANGE' }]);
      const parsed = rules.ok ? rules.rules : { enabled: false };
      const payload: Payload = { serviceTypeId: change.serviceTypeId, cityId: change.cityId, rules: parsed, effectiveFrom: from ? from.toISOString() : null };
      return { payload, resourceId: change.serviceTypeId, cityId: change.cityId,
        summary: { serviceTypeId: change.serviceTypeId, enabled: parsed.enabled, scheduled: from !== null } };
    },

    cityOf(payload: Readonly<Record<string, unknown>>): string | null {
      return typeof payload['cityId'] === 'string' ? payload['cityId'] : null;
    },

    /** Idempotent per change request: a second execution finds its own rule row and does nothing. */
    async execute(changeRequestId: string, stored: Readonly<Record<string, unknown>>, ctx: { now: Date; actorId: string; requestId: string }) {
      const p = stored as Payload;
      const rules = parseServiceRules(p.rules);
      if (!rules.ok) throw new AppError('INVALID_STATE');
      await withTransaction(deps.pool, async (c) => {
        // One writer per service type at a time (rule rows of a type are cut and inserted together).
        if ((await c.query(SQL.lockServiceType, [p.serviceTypeId])).rowCount !== 1) throw new AppError('INVALID_STATE');
        if ((await c.query(SQL.ruleOfChangeRequest, [changeRequestId, p.serviceTypeId, p.cityId])).rowCount === 1) return;
        const requested = p.effectiveFrom ? new Date(p.effectiveFrom) : ctx.now;
        const start = requested.getTime() > ctx.now.getTime() ? requested : ctx.now;
        await c.query(SQL.cutActiveRules, [p.serviceTypeId, p.cityId, start]);
        await c.query(SQL.retireLaterRules, [p.serviceTypeId, p.cityId, start]);
        await c.query(SQL.insertRule, [newId(), p.serviceTypeId, p.cityId, JSON.stringify(rules.rules), start, changeRequestId]);
        await appendAudit(c, { actorType: 'ADMIN', actorId: ctx.actorId, action: 'catalog.service_rules_changed', resourceType: 'catalog.service_type',
          resourceId: p.serviceTypeId, cityId: p.cityId, outcome: 'SUCCESS', requestId: ctx.requestId,
          changeSummary: { changeRequestId, enabled: rules.rules.enabled, defaultRule: p.cityId === null } });
      });
    },
  };
}
