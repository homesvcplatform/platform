// @hsp/observability: allowlist structured logger (Gate 1 minimal form).
// Full field allowlists, OpenTelemetry and canary-PII scanning arrive at Gate 3.
// Rule: only primitive fields with safe names are emitted; anything that looks like a secret or
// personal data is dropped and counted, never printed.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFieldValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogFieldValue>>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field-name tokens that must never be logged (Phase 1 11 §2.1). A field name is split into tokens
 * (snake_case and camelCase) and dropped if any token matches. Deliberately conservative.
 */
export const FORBIDDEN_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'secret', 'token', 'otp', 'pin', 'code', 'cookie', 'session', 'sid',
  'authorization', 'auth', 'apikey', 'key', 'phone', 'mobile', 'msisdn', 'address', 'landmark',
  'aadhaar', 'pan', 'account', 'ifsc', 'vpa', 'upi', 'card', 'name', 'email', 'gender', 'dob',
  'location', 'lat', 'lng', 'latitude', 'longitude', 'ip',
]);

const SAFE_FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export function fieldTokens(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split('_')
    .filter((t) => t.length > 0);
}

export function isFieldAllowed(fieldName: string): boolean {
  if (!SAFE_FIELD_NAME.test(fieldName)) return false;
  return !fieldTokens(fieldName).some((token) => FORBIDDEN_FIELD_TOKENS.has(token));
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly event: string;
  readonly fields: LogFields;
  readonly droppedFieldCount: number;
}

export function buildLogRecord(service: string, level: LogLevel, event: string, fields: LogFields, now: Date): LogRecord {
  const kept: Record<string, LogFieldValue> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (isFieldAllowed(key)) kept[key] = value;
    else dropped += 1;
  }
  return { ts: now.toISOString(), level, service, event, fields: kept, droppedFieldCount: dropped };
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export function createLogger(
  service: string,
  minLevel: LogLevel = 'info',
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  clock: () => Date = () => new Date(),
): Logger {
  return {
    log(level, event, fields = {}) {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
      if (!/^[a-z][a-z0-9_.]{0,79}$/.test(event)) throw new Error('Log event names must be lower_snake/dot case constants');
      sink(JSON.stringify(buildLogRecord(service, level, event, fields, clock())));
    },
  };
}
