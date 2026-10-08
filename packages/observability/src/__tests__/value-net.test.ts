// Gate 3: value-level safety net behind the field allowlist (Phase 1 11 §1).
import { describe, expect, it } from 'vitest';
import { createLogger, isValueSafe } from '../index.ts';

describe('value safety net', () => {
  it.each(['+91 00000 99871', '+910000099871', '9876543210', '482913', 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig', 'a'.repeat(43),
    'someone@example.invalid', 'x'.repeat(201)])('drops suspicious value %s', (value) => {
    expect(isValueSafe(value)).toBe(false);
  });

  it.each(['SUCCESS', 'TECHNICIAN_APP', 'otp_send_ip', '0190f0aa-1111-7222-8333-444455556666', 42, true, null])('keeps %s', (value) => {
    expect(isValueSafe(value)).toBe(true);
  });

  it('counts suspicious values separately and never prints them', () => {
    const lines: string[] = [];
    const logger = createLogger('hsp-test', 'info', (l) => lines.push(l), () => new Date('2026-01-01T00:00:00Z'));
    logger.log('warn', 'auth.example', { outcome: 'FAILED', reason: '+910000099871', role: 'api' });
    const record = JSON.parse(lines[0] ?? '{}');
    expect(lines[0]).not.toContain('0000099871');
    expect(record).toMatchObject({ fields: { outcome: 'FAILED', role: 'api' }, suspiciousValueCount: 1, droppedFieldCount: 0 });
  });
});
