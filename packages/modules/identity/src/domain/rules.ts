// Identity rules (Phase 1 05 §2–§4, errata SR-14, X-14, X-32). Pure functions and constants; no I/O.

export type Surface = 'CUSTOMER_WEB' | 'TECHNICIAN_APP' | 'AGENT_WEB';
export type ActorKindForSurface = 'CUSTOMER' | 'TECHNICIAN' | 'FIELD_AGENT';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 05 §4. */
export const OTP = {
  digits: 6,
  ttlMs: 5 * MIN,
  maxAttempts: 5,
  resendCooldownMs: 30_000,
  perPhonePerHour: 5,
  perPhonePerDay: 10,
} as const;

/** 05 §2.1 / §2.2 / §2.4 / §3.1. */
export const SESSION_POLICY: Readonly<Record<Surface, { readonly idleMs: number; readonly absoluteMs: number }>> = {
  CUSTOMER_WEB: { idleMs: 30 * DAY, absoluteMs: 90 * DAY },
  TECHNICIAN_APP: { idleMs: 30 * DAY, absoluteMs: 90 * DAY }, // refresh token: 30-day sliding, 90-day absolute
  AGENT_WEB: { idleMs: 30 * MIN, absoluteMs: 12 * HOUR },
};

export const ACCESS_TOKEN_TTL_SEC = 600;
export const ACCESS_TOKEN_AUDIENCE = 'tech-app';
/** X-14 / SR-02: only the technician app holds bearer tokens. Browser surfaces use BFF cookie sessions. */
export const surfaceUsesBearerTokens = (s: Surface): boolean => s === 'TECHNICIAN_APP';
export const REFRESH_RETRY_GRACE_MS = 10_000;
export const STEP_UP_VALIDITY_MS = 10 * MIN;
export const SESSION_COOKIE = '__Host-sid';

export function actorKindFor(surface: Surface): ActorKindForSurface {
  return surface === 'CUSTOMER_WEB' ? 'CUSTOMER' : surface === 'TECHNICIAN_APP' ? 'TECHNICIAN' : 'FIELD_AGENT';
}

/** 05 §2.1: `__Host-` prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain. */
export function sessionCookieHeader(value: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Lax`;
}

/** Phase 2 (no production, no real PII): only the reserved fake range is accepted. Real Indian mobiles come later. */
export type PhonePolicy = 'RESERVED_TEST_RANGE_ONLY' | 'INDIAN_MOBILE';
export function phoneAllowed(phone: string, policy: PhonePolicy): boolean {
  return policy === 'RESERVED_TEST_RANGE_ONLY' ? /^\+9100000\d{5}$/.test(phone) : /^\+91[6-9]\d{9}$/.test(phone);
}

/** 11 §2: phones are displayed / logged with the last 2 digits only. */
export function maskPhone(phone: string): string {
  return `+91 ••••• •••${phone.slice(-2)}`;
}

/** 05 §2.3: 4 digits; reject 0000-style repeats, ascending / descending runs and plausible birth years. */
export function pinRejectionReason(pin: string): 'FORMAT' | 'REPEATED' | 'SEQUENCE' | 'YEAR' | undefined {
  if (!/^\d{4}$/.test(pin)) return 'FORMAT';
  if (/^(\d)\1{3}$/.test(pin)) return 'REPEATED';
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - (d[i] ?? 0));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'SEQUENCE';
  const n = Number(pin);
  if (n >= 1940 && n <= 2030) return 'YEAR';
  return undefined;
}

export const IVR_PIN = {
  maxFailuresPerCall: 3,
  maxFailuresPer24h: 5,
  failureWindowMs: DAY,
} as const;

/** SR-14: approvals above the threshold from a device first seen < 24 h ago are held for a confirmation call. */
export function newDeviceApprovalHold(input: { readonly deviceFirstSeenAt: Date; readonly now: Date; readonly amountPaise: number; readonly thresholdPaise: number }): boolean {
  return input.amountPaise > input.thresholdPaise && input.now.getTime() - input.deviceFirstSeenAt.getTime() < DAY;
}

/** X-32: a new-device payout hold applies only with a coinciding payout-method change or a FAILED integrity verdict. */
export function newDevicePayoutHold(input: { readonly newDevice: boolean; readonly payoutMethodChanged: boolean; readonly integrityVerdict: 'MEETS_DEVICE' | 'MEETS_BASIC' | 'FAILED' | 'UNKNOWN' }): boolean {
  return input.newDevice && (input.payoutMethodChanged || input.integrityVerdict === 'FAILED');
}
