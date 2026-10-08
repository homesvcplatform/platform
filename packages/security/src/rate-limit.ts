// Rate limiting (Phase 1 04 §1.5): token buckets keyed per dimension (phone, IP, device, session, user, admin).
// The store is a port: Valkey (atomic Lua script) when deployed; `MemoryRateLimitStore` in local/CI and tests.
// Keys never contain raw personal data: callers pass blind indexes / keyed hashes (e.g. the client IP's HMAC).

export interface RateLimitRule {
  readonly name: string;
  /** Bucket size: the burst allowed. */
  readonly capacity: number;
  /** Seconds for a full refill (capacity tokens per window). */
  readonly windowSec: number;
}

export interface RateLimitStore {
  /** Atomically takes one token from bucket `key` under `rule`. */
  take(key: string, rule: RateLimitRule, now: Date): Promise<{ readonly allowed: boolean; readonly retryAfterSec: number }>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  async take(key: string, rule: RateLimitRule, now: Date) {
    const t = now.getTime();
    const rate = rule.capacity / (rule.windowSec * 1000);
    const bucket = this.#buckets.get(key) ?? { tokens: rule.capacity, at: t };
    const tokens = Math.min(rule.capacity, bucket.tokens + Math.max(0, t - bucket.at) * rate);
    if (tokens >= 1) {
      this.#buckets.set(key, { tokens: tokens - 1, at: t });
      return { allowed: true, retryAfterSec: 0 };
    }
    this.#buckets.set(key, { tokens, at: t });
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
  }
}

export interface RateLimitCheck {
  readonly rule: RateLimitRule;
  /** Opaque dimension value (hash / id). Missing dimensions are skipped. */
  readonly key: string | undefined;
}

export interface RateLimiter {
  /** Consumes from every applicable bucket; denied if any bucket is empty. */
  consume(checks: readonly RateLimitCheck[], now: Date): Promise<{ readonly allowed: boolean; readonly retryAfterSec: number; readonly limitedBy?: string }>;
}

export function createRateLimiter(store: RateLimitStore): RateLimiter {
  return {
    async consume(checks, now) {
      let worst: { allowed: boolean; retryAfterSec: number; limitedBy?: string } = { allowed: true, retryAfterSec: 0 };
      for (const check of checks) {
        if (check.key === undefined) continue;
        const r = await store.take(`${check.rule.name}:${check.key}`, check.rule, now);
        if (!r.allowed && r.retryAfterSec >= worst.retryAfterSec) worst = { allowed: false, retryAfterSec: r.retryAfterSec, limitedBy: check.rule.name };
      }
      return worst;
    },
  };
}

/** Default limits from 04 §1.5 (configurable per deployment). */
export const RATE_RULES = {
  otpSendPerIp: { name: 'otp_send_ip', capacity: 20, windowSec: 3600 },
  otpSendPerDevice: { name: 'otp_send_device', capacity: 10, windowSec: 3600 },
  /** Global breaker: above this OTP send rate every send needs a passing bot check (ST-09). */
  otpSendGlobal: { name: 'otp_send_global', capacity: 600, windowSec: 60 },
  otpVerifyPerIp: { name: 'otp_verify_ip', capacity: 60, windowSec: 3600 },
  refreshPerSession: { name: 'refresh_session', capacity: 30, windowSec: 3600 },
  read: { name: 'read', capacity: 120, windowSec: 60 },
  write: { name: 'write', capacity: 30, windowSec: 60 },
  critical: { name: 'critical', capacity: 10, windowSec: 60 },
  admin: { name: 'admin', capacity: 120, windowSec: 60 },
  adminReveal: { name: 'admin_reveal', capacity: 20, windowSec: 3600 },
} as const satisfies Record<string, RateLimitRule>;
