// Service rules (Phase 1 03 §8 / §8.1, ADR-020, ADR-025 #7): per service type, a default rule (all cities) and optional
// city rules, effective-dated. The JSON is validated here; unknown keys are refused so a typo can't silently do nothing.
import { z } from 'zod';

export const serviceRulesSchema = z.strictObject({
  /** City-scoped bookability (ADR-020). Required: a rule always states whether the service type is offered. */
  enabled: z.boolean(),
  same_visit_repair_allowed: z.boolean().optional(),
  min_verification_level: z.int().min(0).max(3).optional(),
  quote_expiry_hours: z.int().min(1).max(720).optional(),
  /** Marks synthetic fixture configuration (never production values). */
  fixture: z.literal('NOT_FINAL').optional(),
});

export type ServiceRules = z.infer<typeof serviceRulesSchema>;

export function parseServiceRules(value: unknown): { ok: true; rules: ServiceRules } | { ok: false; issues: { path: string; code: string }[] } {
  const r = serviceRulesSchema.safeParse(value);
  return r.success ? { ok: true, rules: r.data }
    : { ok: false, issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code.toUpperCase() })) };
}

/** A city rule replaces the default rule as a whole (no merge). No rule at all means not offered (fail closed). */
export function effectiveRule<T>(cityRule: T | undefined, defaultRule: T | undefined): T | undefined {
  return cityRule ?? defaultRule;
}
