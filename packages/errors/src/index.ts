// @hsp/errors: domain error taxonomy and RFC 9457 problem+json mapping (Phase 1 04 §1.4).
// Rules: messages never reveal whether a phone is registered, whether an object exists for someone else, or internal
// identifiers. Unknown errors map to 500 INTERNAL with no details.

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  OTP_INVALID: 400,
  SLOT_UNAVAILABLE: 400,
  CODE_INCORRECT: 400,
  UNAUTHENTICATED: 401,
  SESSION_REVOKED: 401,
  STEP_UP_REQUIRED: 401,
  SECOND_FACTOR_REQUIRED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  ACCOUNT_SUSPENDED: 403,
  FEATURE_DISABLED: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  INVALID_STATE: 409,
  REQUEST_IN_PROGRESS: 409,
  POSSIBLE_DUPLICATE: 409,
  PRICE_CHANGED: 409,
  PRICE_RECALCULATED: 409,
  QUOTE_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  OPTION_UNAVAILABLE: 409,
  CHANGE_PENDING: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  NOT_SERVICEABLE: 422,
  CUSTOM_LABOUR_OUT_OF_BAND: 422,
  CODE_LOCKED: 423,
  RATE_LIMITED: 429,
  BOT_CHECK_REQUIRED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  readonly fields: readonly { readonly path: string; readonly code: string }[];
  /** Client-safe extra facts named by the API contract (ids, amounts, counters only), e.g. `existingJobId`, `attemptsLeft`. */
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(code: ErrorCode, opts: { retryAfterSec?: number; fields?: readonly { path: string; code: string }[];
    details?: Readonly<Record<string, string | number | boolean>> } = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryAfterSec = opts.retryAfterSec;
    this.fields = opts.fields ?? [];
    this.details = opts.details ?? {};
  }
}

export interface Problem {
  readonly type: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detailKey: string;
  readonly requestId: string;
  readonly fields?: readonly { readonly path: string; readonly code: string }[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

const titleOf = (code: ErrorCode) => code.toLowerCase().replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

/** Maps any thrown value to a client-safe problem document. Non-AppErrors become INTERNAL without details. */
export function toProblem(error: unknown, requestId: string, errorBaseUrl = 'https://errors.invalid'): Problem {
  const app = error instanceof AppError ? error : new AppError('INTERNAL');
  return {
    type: `${errorBaseUrl}/${app.code}`,
    status: app.status,
    code: app.code,
    title: titleOf(app.code),
    detailKey: `errors.${app.code.toLowerCase()}`,
    requestId,
    ...(app.fields.length > 0 ? { fields: app.fields } : {}),
    ...(Object.keys(app.details).length > 0 ? { details: app.details } : {}),
  };
}
