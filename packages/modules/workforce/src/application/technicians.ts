// Read-only technician facts for Gate 5 assignment (ADR-026 #11): exists, ACTIVE, and the concurrent-assignment
// capacity used by INV-03. Gate 6 (ADR-027): whether a technician holds an ACTIVE, verified repair skill for a service
// type (and specialization) - the "diagnosing technician is qualified" fact behind the repair options (02 §4, Q-A) and
// the same-visit guard (06 §3). Areas and the other eligibility filters belong to matching (Gate 7).
import type pg from 'pg';

export const WORKFORCE_SQL = {
  technician: 'SELECT user_id, city_id, status, capacity FROM workforce.technician_profiles WHERE user_id = $1',
  // A specialised repair needs the specialization itself; an unspecialised one is covered by any repair skill of the type.
  repairSkill: `
    SELECT 1 FROM workforce.technician_skills s JOIN workforce.technician_profiles p ON p.user_id = s.technician_user_id
     WHERE s.technician_user_id = $1 AND s.service_type_id = $2 AND s.status = 'ACTIVE' AND s.can_repair
       AND s.level IN ('ASSESSED','CERTIFIED') AND (s.valid_until IS NULL OR s.valid_until > $4::timestamptz)
       AND p.status = 'ACTIVE' AND ($3::uuid IS NULL OR s.specialization_id = $3::uuid)
     LIMIT 1`,
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

  /** True when an ACTIVE technician holds a verified (ASSESSED / CERTIFIED), unexpired repair skill for the type / specialization. */
  async repairQualified(technicianUserId: string, serviceTypeId: string, specializationId: string | null, at: Date): Promise<boolean> {
    if (!UUID.test(technicianUserId) || !UUID.test(serviceTypeId) || (specializationId !== null && !UUID.test(specializationId))) return false;
    return (await this.#pool.query(WORKFORCE_SQL.repairSkill, [technicianUserId, serviceTypeId, specializationId, at])).rows.length > 0;
  }
}
