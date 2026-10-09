// Gate 3: problem+json mapping never leaks internals (Phase 1 04 §1.4).
import { describe, expect, it } from 'vitest';
import { AppError, toProblem } from '../index.ts';

describe('problem+json', () => {
  it('maps app errors with status, code and detail key', () => {
    const p = toProblem(new AppError('RATE_LIMITED', { retryAfterSec: 30 }), 'req-1');
    expect(p).toMatchObject({ status: 429, code: 'RATE_LIMITED', detailKey: 'errors.rate_limited', requestId: 'req-1' });
  });

  it('turns anything else into a bare 500 without the message', () => {
    const p = toProblem(new Error('duplicate key value violates unique constraint "users_phone_bidx_uq"'), 'req-2');
    expect(p).toEqual({ type: 'https://errors.invalid/INTERNAL', status: 500, code: 'INTERNAL', title: 'Internal', detailKey: 'errors.internal', requestId: 'req-2' });
    expect(JSON.stringify(p)).not.toContain('users_phone');
  });
});
