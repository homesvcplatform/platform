// Environment & configuration validation (Phase 2 / 02 §4).
// Every process validates its environment at boot and refuses to start on invalid config.
// Error messages name the offending keys but never echo values (they may be secrets).
import { z } from 'zod';

/** Phase 2 has no production environment. "prod" is deliberately absent (no-production guardrail). */
export const DEPLOYABLE_ENVIRONMENTS = ['local', 'dev', 'test', 'staging'] as const;
export type AppEnvironment = (typeof DEPLOYABLE_ENVIRONMENTS)[number];

export const PROCESS_ROLES = ['api', 'admin-api', 'webhook', 'voice', 'worker', 'scheduler', 'media-scanner'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

const awsAccountId = z.string().regex(/^\d{12}$/, 'must be a 12-digit AWS account id');

export const baseEnvSchema = z.object({
  APP_ENV: z.enum(DEPLOYABLE_ENVIRONMENTS),
  APP_ROLE: z.enum(PROCESS_ROLES),
  /** 0 = OS-assigned port (tests). Deployed task definitions always set an explicit port. */
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AWS_REGION: z.literal('ap-south-1').optional(),
  AWS_ACCOUNT_ID: awsAccountId.optional(),
  /** Comma-separated allowlist of non-production AWS accounts this build may run in. */
  NONPROD_AWS_ACCOUNT_IDS: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(z.array(awsAccountId))
    .optional(),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Parse and validate environment variables. Throws ConfigError listing keys only (no values). */
export function loadConfig<S extends z.ZodType>(schema: S, env: Readonly<Record<string, string | undefined>>): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  return result.data;
}
