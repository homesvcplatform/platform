// Read-only technician facts for Gate 5 assignment (ADR-026 #11): exists, ACTIVE, and the concurrent-assignment
// capacity used by INV-03. Skills, areas and eligibility filters belong to matching (Gate 7).
import type pg from 'pg';

export const WORKFORCE_SQL = {
  technician: 'SELECT user_id, city_id, status, capacity FROM workforce.technician_profiles WHERE user_id = $1',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class TechnicianDirectory {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** The technician's city and capacity if ACTIVE, else null. */
  async assignable(technicianUserId: string): Promise<{ cityId: string; capacity: number } | null> {
    if (!UUID.test(technicianUserId)) return null;
    const r = (await this.#pool.query(WORKFORCE_SQL.technician, [technicianUserId])).rows[0] as Record<string, unknown> | undefined;
    return r && r['status'] === 'ACTIVE' ? { cityId: r['city_id'] as string, capacity: Number(r['capacity']) } : null;
  }
}
