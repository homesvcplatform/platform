// @hsp/observability: allowlist structured logger (Phase 1 11 §2). Gate 3 adds the value-level safety net; the
// canary-PII scan over captured logs lives in @hsp/testing. OpenTelemetry arrives with deployment wiring.
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

/**
 * Value-level safety net (Phase 1 11 §1, second line of defence after the field allowlist): string values that look
 * like phone numbers, one-time codes, JWTs, long bearer secrets or e-mail addresses are dropped even under an
 * allowed field name. Each hit is counted as `suspiciousValueCount`; any non-zero count means the allowlist failed.
 */
const SUSPICIOUS_VALUE: readonly RegExp[] = [
  /(?:\+|\b)91[\s-]?[0-9]{5}[\s-]?[0-9]{5}\b/, // +91 phone, any grouping
  /\b[0-9]{10}\b/, // bare 10-digit mobile numbers
  /^[0-9]{4,8}$/, // a value that is only a short code (OTP, PIN, visit code)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /[A-Za-z0-9_-]{40,}/, // long opaque secrets (refresh tokens, session cookies)
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // e-mail
];

export function isValueSafe(value: LogFieldValue): boolean {
  if (typeof value !== 'string') return true;
  if (value.length > 200) return false;
  return !SUSPICIOUS_VALUE.some((pattern) => pattern.test(value));
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly event: string;
  readonly fields: LogFields;
  readonly droppedFieldCount: number;
  readonly suspiciousValueCount: number;
}

export function buildLogRecord(service: string, level: LogLevel, event: string, fields: LogFields, now: Date): LogRecord {
  const kept: Record<string, LogFieldValue> = {};
  let dropped = 0;
  let suspicious = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!isFieldAllowed(key)) dropped += 1;
    else if (!isValueSafe(value)) suspicious += 1;
    else kept[key] = value;
  }
  return { ts: now.toISOString(), level, service, event, fields: kept, droppedFieldCount: dropped, suspiciousValueCount: suspicious };
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
