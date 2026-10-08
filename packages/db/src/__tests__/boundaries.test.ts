import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertModuleOwnsSql, ModuleBoundaryError, ownershipFromModulesJson, referencedSchemas, allSchemas } from '../query-guard.ts';
import { TransactionBoundaryError, UnitOfWork } from '../unit-of-work.ts';

const spec = JSON.parse(readFileSync(new URL('../../../../tools/architecture/modules.json', import.meta.url), 'utf8'));
const ownership = ownershipFromModulesJson(spec);

describe('B2 query ownership guard', () => {
  it('allows a module its own schemas plus platform', () => {
    expect(() => assertModuleOwnsSql('jobs', 'SELECT id FROM jobs.visits v JOIN jobs.jobs j ON j.id = v.job_id', ownership)).not.toThrow();
    expect(() => assertModuleOwnsSql('jobs', 'INSERT INTO platform.outbox (id) VALUES ($1)', ownership)).not.toThrow();
    expect(() => assertModuleOwnsSql('payments', 'INSERT INTO ledger.entries (transaction_id) VALUES ($1)', ownership)).not.toThrow();
  });

  it.each([
    ['jobs', 'SELECT * FROM diagnosis.quotes', ['diagnosis']],
    ['matching', 'UPDATE jobs.visits SET status = $1', ['jobs']],
    ['api-less module reading the ledger', 'SELECT * FROM ledger.entries', ['ledger']],
    ['trust', 'SELECT * FROM "customers"."customer_sensitive_attributes"', ['customers']],
  ])('rejects %s', (module, sql, foreign) => {
    const mod = module.includes(' ') ? 'jobs' : module;
    try {
      assertModuleOwnsSql(mod, sql, ownership);
      throw new Error('expected a ModuleBoundaryError');
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleBoundaryError);
      expect((error as ModuleBoundaryError).foreignSchemas).toEqual(foreign);
    }
  });

  it('ignores schema names inside comments and string literals', () => {
    const sql = "-- see diagnosis.quotes\nSELECT 'payments.bills' AS note /* ledger.entries */ FROM jobs.jobs";
    expect([...referencedSchemas(sql, allSchemas(ownership))]).toEqual(['jobs']);
  });

  it('knows every module schema plus ledger and platform', () => {
    const schemas = allSchemas(ownership);
    for (const def of Object.values(spec.modules) as { schema: string }[]) expect(schemas.has(def.schema)).toBe(true);
    expect(schemas.has('ledger')).toBe(true);
    expect(schemas.has('platform')).toBe(true);
  });
});

describe('B4 unit of work', () => {
  const tcps = spec.transactionalCouplingPoints;

  it('allows same-module work and the three approved coupling points', () => {
    const uow = new UnitOfWork('matching', tcps);
    uow.join('matching', 'matching', 'recordOffer');
    uow.join('matching', 'jobs', 'assignVisit');
    uow.join('jobs', 'diagnosis', 'recordMaterialUsage');
    uow.join('jobs', 'payments', 'issueBill');
    expect(uow.joined).toEqual(['TCP-1:jobs.assignVisit', 'TCP-2:diagnosis.recordMaterialUsage', 'TCP-3:payments.issueBill']);
  });

  it.each([
    ['matching', 'payments', 'issueBill'],
    ['jobs', 'payments', 'refund'],
    ['payments', 'jobs', 'assignVisit'],
    ['api', 'ledger', 'post'],
  ])('rejects %s -> %s.%s', (caller, callee, operation) => {
    expect(() => new UnitOfWork(caller, tcps).join(caller, callee, operation)).toThrow(TransactionBoundaryError);
  });
});
