// Gate 5 exit criteria at the database level (ADR-026 #5): the transition table in the database equals the code
// tables; any other status change is refused (property test over random pairs); every status change writes history
// with actor and channel (INV-18); INV-14, INV-15, INV-04 and INV-25 guards. Throwaway database, synthetic rows.
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@hsp/kernel';
import { allowedTransitions, MACHINES, newPublicRef, statesOf, type Machine } from '@hsp/module-jobs';
import { createTestDatabase, inRollback, sqlState, type TestDatabase } from '@hsp/testing';

let db: TestDatabase;
const c = () => db.migrator;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function actor(reason: string | null = null): Promise<void> {
  await c().query(`SELECT set_config('hsp.actor_type', 'SYSTEM', true), set_config('hsp.channel', 'TEST', true),
    set_config('hsp.correlation_id', $1, true), set_config('hsp.reason_code', $2, true)`, [newId(), reason ?? '']);
}

async function job(status = 'REQUESTED'): Promise<string> {
  const id = newId();
  await c().query(`INSERT INTO jobs.jobs (id, public_ref, customer_user_id, city_id, zone_id, locality_id, service_type_id, address_id,
      address_snapshot_enc, channel, payment_preference, onsite_adult, created_by_actor_type, created_by_actor_id, customer_verified,
      client_request_id, status, visit_fee_snapshot_id)
    VALUES ($1, $7, $2, $3, $3, $3, $3, $3, $4, 'PWA', 'EITHER', 'SELF', 'CUSTOMER', $2, true, $5, $6, $3)`,
  [id, newId(), newId(), randomBytes(16), newId(), status, newPublicRef()]);
  return id;
}

async function visit(jobId: string, opts: { status?: string; repairOrderId?: string; seq?: number } = {}): Promise<string> {
  const id = newId();
  const repair = opts.repairOrderId !== undefined;
  await c().query(`INSERT INTO jobs.visits (id, job_id, city_id, locality_id, sequence_no, purposes, repair_order_id, required_service_type_id,
      required_capability, service_window, urgency, status, start_code_hash, completion_code_hash, visit_code)
    VALUES ($1, $2, $3, $3, $4, $5, $6, $3, $7, tstzrange(now(), now() + interval '2 hours'), 'ASAP', $8, $9, $10, '1234')`,
  [id, jobId, newId(), opts.seq ?? 1, repair ? ['REPAIR'] : ['DIAGNOSIS'], opts.repairOrderId ?? null, repair ? 'REPAIR' : 'DIAGNOSE',
    opts.status ?? 'PLANNED', randomBytes(32), repair ? randomBytes(32) : null]);
  return id;
}

async function repairOrder(jobId: string, status = 'AWAITING_SCHEDULE'): Promise<string> {
  const id = newId();
  await c().query(`INSERT INTO jobs.repair_orders (id, job_id, quote_id, quote_version_id, required_service_type_id, performer_preference,
      allow_fallback, materials_required, materials_supplied_by, status)
    VALUES ($1, $2, $3, $3, $3, 'RECOMMENDED_SPECIALIST', true, '[]', 'NONE', $4)`, [id, jobId, newId(), status]);
  return id;
}

/** Moves a visit along allowed edges (with the presence proof ON_SITE needs). */
async function walk(visitId: string, ...states: string[]): Promise<void> {
  for (const s of states) {
    if (s === 'ON_SITE') {
      await c().query(`INSERT INTO jobs.visit_presence_proofs (id, visit_id, kind, channel, actor_type) VALUES ($1, $2, 'START_CODE', 'APP', 'TECHNICIAN')`, [newId(), visitId]);
      await c().query("UPDATE jobs.visits SET status = 'ON_SITE', arrived_at = now() WHERE id = $1", [visitId]);
    } else {
      await c().query('UPDATE jobs.visits SET status = $2 WHERE id = $1', [visitId, s]);
    }
  }
}

describe('transition table', () => {
  it('the database table equals the code tables (creations included)', async () => {
    const rows = (await c().query('SELECT machine, from_status AS "from", to_status AS "to" FROM jobs.allowed_transitions ORDER BY 1, 2, 3')).rows;
    const code = [...allowedTransitions()].sort((a, b) => `${a.machine}|${a.from}|${a.to}`.localeCompare(`${b.machine}|${b.from}|${b.to}`));
    const key = (r: { machine: string; from: string; to: string }) => `${r.machine}|${r.from}|${r.to}`;
    expect(rows.map(key).sort()).toEqual(code.map(key).sort());
  });

  it('every status value in the code tables is one the Gate 2 CHECK constraints accept', async () => {
    for (const [machine, table] of [['job', 'jobs'], ['visit', 'visits'], ['assignment', 'assignments'], ['repair_order', 'repair_orders']] as const) {
      const def = (await c().query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status = ANY%' LIMIT 1`, [`jobs.${table}`])).rows[0]?.d as string;
      for (const s of statesOf(machine)) expect(def, `${machine} ${s}`).toContain(`'${s}'`);
    }
  });

  it('property: a random status change on a live visit is accepted exactly when the table allows it', async () => {
    const states = statesOf('visit');
    await fc.assert(fc.asyncProperty(fc.constantFrom(...states), fc.constantFrom(...states), async (from, to) => {
      await inRollback(c(), async () => {
        await actor();
        const j = await job();
        const v = await visit(j);
        // Reach `from` by a direct insert path: create the visit at PLANNED and force the starting state as the owner
        // would never do in production (the guard is bypassed only by disabling the trigger inside this rolled-back test).
        await c().query('ALTER TABLE jobs.visits DISABLE TRIGGER guard_transition');
        await c().query('ALTER TABLE jobs.visits DISABLE TRIGGER guard_presence');
        await c().query("UPDATE jobs.visits SET status = $2, arrived_at = CASE WHEN $2 IN ('ON_SITE','IN_PROGRESS','COMPLETED') THEN now() END, completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() END WHERE id = $1", [v, from]);
        await c().query('ALTER TABLE jobs.visits ENABLE TRIGGER guard_transition');
        await c().query('ALTER TABLE jobs.visits ENABLE TRIGGER guard_presence');
        await c().query(`INSERT INTO jobs.visit_presence_proofs (id, visit_id, kind, channel, actor_type) VALUES ($1, $2, 'START_CODE', 'APP', 'TECHNICIAN')`, [newId(), v]);
        const allowed = (MACHINES.visit.transitions as Record<string, readonly string[]>)[from]?.includes(to) ?? false;
        const state = await sqlState(c(), `UPDATE jobs.visits SET status = $2, arrived_at = coalesce(arrived_at, now()),
            completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END WHERE id = $1`, [v, to]);
        if (from === to) expect(state).toBe('OK');
        else expect(state, `${from} → ${to}`).toBe(allowed ? 'OK' : 'HS030');
      });
    }), { numRuns: 80 });
  });

  it.each([
    ['job', 'REQUESTED', 'AWAITING_APPROVAL'], ['job', 'REQUESTED', 'CLOSED'], ['visit', 'PLANNED', 'ASSIGNED'], ['visit', 'PLANNED', 'EN_ROUTE'],
  ] as const)('%s %s → %s is refused (HS030)', async (machine: Machine, from, to) => {
    await inRollback(c(), async () => {
      await actor();
      const j = await job(machine === 'job' ? from : 'REQUESTED');
      const target = machine === 'job' ? j : await visit(j, { status: from });
      const table = machine === 'job' ? 'jobs' : 'visits';
      expect(await sqlState(c(), `UPDATE jobs.${table} SET status = $2 WHERE id = $1`, [target, to])).toBe('HS030');
    });
  });

  it('creation only in an initial state (job REQUESTED, visit PLANNED, assignment ACTIVE)', async () => {
    await inRollback(c(), async () => {
      await actor();
      await expect(job('CLOSED')).rejects.toMatchObject({ code: 'HS030' });
    });
    await inRollback(c(), async () => {
      await actor();
      const j = await job();
      await expect(visit(j, { status: 'ASSIGNED' })).rejects.toMatchObject({ code: 'HS030' });
    });
  });
});

describe('INV-18: every status change has a history row with actor and channel', () => {
  it('a change without the actor context is refused (HS031)', async () => {
    await inRollback(c(), async () => {
      await expect(job()).rejects.toMatchObject({ code: 'HS031' });
    });
  });

  it('job, visit, assignment and repair-order changes are all recorded', async () => {
    await inRollback(c(), async () => {
      await actor('TEST_REASON');
      const j = await job();
      const v = await visit(j);
      await walk(v, 'MATCHING');
      const a = newId();
      await c().query(`INSERT INTO jobs.assignments (id, visit_id, technician_user_id, assigned_via, assigned_by_actor_type, assigned_by_actor_id, manual_reason_code, status)
        VALUES ($1, $2, $3, 'MANUAL_OPS', 'ADMIN', $3, 'TEST', 'ACTIVE')`, [a, v, newId()]);
      await c().query("UPDATE jobs.assignments SET status = 'RELEASED', ended_at = now() WHERE id = $1", [a]);
      const ro = await repairOrder(j);
      await c().query("UPDATE jobs.repair_orders SET status = 'CANCELLED' WHERE id = $1", [ro]);
      const count = async (table: string, col: string, id: string) =>
        (await c().query(`SELECT count(*)::int AS n FROM jobs.${table} WHERE ${col} = $1 AND channel = 'TEST' AND actor_type = 'SYSTEM' AND reason_code = 'TEST_REASON'`, [id])).rows[0].n as number;
      expect(await count('job_status_history', 'job_id', j)).toBe(1);
      expect(await count('visit_status_history', 'visit_id', v)).toBe(2);
      expect(await count('assignment_status_history', 'assignment_id', a)).toBe(2);
      expect(await count('repair_order_status_history', 'repair_order_id', ro)).toBe(2);
      expect(await sqlState(c(), 'DELETE FROM jobs.assignment_status_history WHERE assignment_id = $1', [a])).toBe('HS001');
    });
  });
});

describe('presence and close invariants', () => {
  it('INV-14: ON_SITE only with a start-code or audited-override proof', async () => {
    await inRollback(c(), async () => {
      await actor();
      const v = await visit(await job());
      await walk(v, 'MATCHING', 'ASSIGNED', 'EN_ROUTE');
      expect(await sqlState(c(), "UPDATE jobs.visits SET status = 'ON_SITE', arrived_at = now() WHERE id = $1", [v])).toBe('HS032');
      await walk(v, 'ON_SITE');
    });
  });

  it('INV-15: a repair visit completes only with a completion-code or audited-override proof; a diagnosis visit needs none', async () => {
    await inRollback(c(), async () => {
      await actor();
      const j = await job();
      const ro = await repairOrder(j);
      const v = await visit(j, { repairOrderId: ro, seq: 2 });
      await walk(v, 'MATCHING', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS');
      expect(await sqlState(c(), "UPDATE jobs.visits SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [v])).toBe('HS033');
      await c().query(`INSERT INTO jobs.visit_presence_proofs (id, visit_id, kind, channel, actor_type) VALUES ($1, $2, 'COMPLETION_CODE', 'APP', 'TECHNICIAN')`, [newId(), v]);
      expect(await sqlState(c(), "UPDATE jobs.visits SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [v])).toBe('OK');
      const d = await visit(j);
      await walk(d, 'MATCHING', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS');
      expect(await sqlState(c(), "UPDATE jobs.visits SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [d])).toBe('OK');
    });
  });

  it('INV-04: a repair order can be IN_PROGRESS only with a linked visit on site (checked at commit)', async () => {
    await c().query('BEGIN');
    try {
      await actor();
      const j = await job();
      const ro = await repairOrder(j);
      await c().query("UPDATE jobs.repair_orders SET status = 'SCHEDULED' WHERE id = $1", [ro]);
      await c().query("UPDATE jobs.repair_orders SET status = 'IN_PROGRESS' WHERE id = $1", [ro]);
      await expect(c().query('COMMIT')).rejects.toMatchObject({ code: 'HS035' });
    } finally {
      await c().query('ROLLBACK').catch(() => undefined);
    }
    await c().query('BEGIN');
    try {
      await actor();
      const j = await job();
      const ro = await repairOrder(j);
      const v = await visit(j, { repairOrderId: ro });
      await walk(v, 'MATCHING', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE');
      await c().query("UPDATE jobs.repair_orders SET status = 'SCHEDULED' WHERE id = $1", [ro]);
      await c().query("UPDATE jobs.repair_orders SET status = 'IN_PROGRESS' WHERE id = $1", [ro]);
      await c().query('COMMIT');
    } catch (error) {
      await c().query('ROLLBACK');
      throw error;
    }
  });

  it('INV-25: a job can not close with an open repair order or a safety hold', async () => {
    await inRollback(c(), async () => {
      await actor();
      const j = await job();
      await c().query("UPDATE jobs.jobs SET status = 'IN_DIAGNOSIS' WHERE id = $1", [j]);
      await c().query("UPDATE jobs.jobs SET status = 'AWAITING_APPROVAL' WHERE id = $1", [j]);
      const ro = await repairOrder(j);
      const close = () => sqlState(c(), "UPDATE jobs.jobs SET status = 'CLOSED', close_reason = 'QUOTE_REJECTED', closed_at = now() WHERE id = $1", [j]);
      expect(await close()).toBe('HS034');
      await c().query("UPDATE jobs.repair_orders SET status = 'CANCELLED' WHERE id = $1", [ro]);
      await c().query('UPDATE jobs.jobs SET safety_hold = true WHERE id = $1', [j]);
      expect(await close()).toBe('HS034');
      await c().query('UPDATE jobs.jobs SET safety_hold = false WHERE id = $1', [j]);
      expect(await close()).toBe('OK');
    });
  });
});
