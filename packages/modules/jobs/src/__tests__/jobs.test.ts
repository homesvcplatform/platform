// Gate 5: jobs policies (customer owner / technician assignee / admin city scope), SQL ownership (B2) and the TCP-3
// coupling point the service joins (B4) against modules.json. Gate 6: the repair-order / completion-code policies and
// TCP-2 (material usage at repair completion).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ownershipFromModulesJson, UnitOfWork } from '@hsp/db';
import { PolicyRegistry, type Actor } from '@hsp/policy';
import { JOBS_SQL, registerJobsPolicies, TIMER_TASKS } from '../public/index.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));
const r = new PolicyRegistry();
registerJobsPolicies(r);
const ctx = { now: new Date() };
const customer: Actor = { kind: 'CUSTOMER', id: 'c1', sessionId: 's1', surface: 'CUSTOMER_WEB' };
const technician: Actor = { kind: 'TECHNICIAN', id: 't1', sessionId: 's2', surface: 'TECHNICIAN_APP' };
const admin = (perms: Record<string, string[] | 'GLOBAL'>): Actor => ({ kind: 'ADMIN', id: 'a1', sessionId: 's3',
  permissions: new Map(Object.entries(perms).map(([p, s]) => [p, s === 'GLOBAL' ? [{ kind: 'GLOBAL' as const }] : [{ kind: 'CITIES' as const, cityIds: s }]])) });

describe('jobs policies', () => {
  it('customers book from a web session and see / cancel only their own jobs (404 otherwise)', () => {
    expect(r.can(customer, 'jobs.job.create', {}, ctx).allow).toBe(true);
    expect(r.can({ ...customer, surface: 'TECHNICIAN_APP' }, 'jobs.job.create', {}, ctx).allow).toBe(false);
    expect(r.can(technician, 'jobs.job.create', {}, ctx).allow).toBe(false);
    for (const action of ['jobs.job.read', 'jobs.job.cancel', 'jobs.visit.start_code', 'jobs.visit.completion_code', 'jobs.repair_order.read',
      'jobs.repair_order.schedule', 'jobs.repair_order.cancel']) {
      expect(r.can(customer, action, { ownerUserId: 'c1' }, ctx).allow).toBe(true);
      expect(r.can(customer, action, { ownerUserId: 'c2' }, ctx)).toMatchObject({ allow: false, status: 404 });
      expect(r.can(customer, action, { ownerUserId: null }, ctx)).toMatchObject({ allow: false, status: 404 });
    }
  });

  it('technicians act only on their own assignment, from the app (IVR: Gate 10)', () => {
    expect(r.can(technician, 'jobs.visit.act', { isAssignee: true }, ctx).allow).toBe(true);
    expect(r.can(technician, 'jobs.visit.act', { isAssignee: false }, ctx)).toMatchObject({ allow: false, status: 404 });
    expect(r.can({ ...technician, surface: 'TECHNICIAN_IVR' }, 'jobs.visit.act', { isAssignee: true }, ctx).allow).toBe(false);
    expect(r.can(customer, 'jobs.visit.read_assigned', { isAssignee: true }, ctx).allow).toBe(false);
  });

  it('ops actions need the permission for the city', () => {
    const dispatch = admin({ 'dispatch.assign': ['k1'] });
    expect(r.can(dispatch, 'jobs.visit.assign_manual', { cityId: 'k1' }, ctx).allow).toBe(true);
    expect(r.can(dispatch, 'jobs.visit.assign_manual', { cityId: 'k2' }, ctx).allow).toBe(false);
    expect(r.can(dispatch, 'jobs.visit.assign_manual', { cityId: undefined }, ctx).allow).toBe(true);
    expect(r.can(dispatch, 'jobs.job.create_assisted', { cityId: 'k1' }, ctx).allow).toBe(false);
    expect(r.can(admin({ 'support.book': ['k1'] }), 'jobs.job.create_assisted', { cityId: 'k1' }, ctx).allow).toBe(true);
    expect(r.can(admin({ 'support.book': 'GLOBAL' }), 'jobs.job.confirm_customer', { cityId: 'k9' }, ctx).allow).toBe(true);
    expect(r.can(customer, 'jobs.visit.assign_manual', { cityId: 'k1' }, ctx).allow).toBe(false);
  });
});

describe('architecture', () => {
  it('B2: jobs SQL touches only jobs and platform', () => {
    const ownership = ownershipFromModulesJson(spec);
    for (const [name, sql] of Object.entries(JOBS_SQL)) expect(() => assertModuleOwnsSql('jobs', sql, ownership), name).not.toThrow();
  });

  it('B4: TCP-2 (jobs → diagnosis.recordMaterialUsage) and TCP-3 (jobs → payments.issueBill) are approved coupling points; anything else is refused', () => {
    const uow = new UnitOfWork('jobs', spec.transactionalCouplingPoints);
    expect(() => uow.join('jobs', 'payments', 'issueBill')).not.toThrow();
    expect(() => uow.join('jobs', 'diagnosis', 'recordMaterialUsage')).not.toThrow();
    expect(() => uow.join('jobs', 'pricing', 'snapshot')).toThrow();
    expect(() => uow.join('jobs', 'diagnosis', 'versionFacts')).toThrow();
  });

  it('timer task names fit the platform.schedule_timer pattern', () => {
    for (const t of Object.values(TIMER_TASKS)) expect(t).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/);
  });
});
