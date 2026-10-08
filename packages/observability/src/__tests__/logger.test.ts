import { describe, expect, it } from 'vitest';
import { createLogger, isFieldAllowed } from '../index.ts';

describe('allowlist logger (Gate 1 minimal)', () => {
  it.each(['phone', 'phoneNumber', 'customer_phone', 'otp', 'otpCode', 'pin', 'accessToken', 'refresh_token', 'password',
    'address', 'addressLine1', 'landmark', 'aadhaarNumber', 'accountNumber', 'ifsc', 'upiVpa', 'customerName', 'email',
    'lat', 'lng', 'clientIp', 'sessionId', 'apiKey', 'Bad-Name'])('drops forbidden field %s', (field) => {
    expect(isFieldAllowed(field)).toBe(false);
  });

  it.each(['role', 'appEnv', 'port', 'jobRef', 'visitId', 'status', 'durationMs', 'mapping'])('keeps safe field %s', (field) => {
    expect(isFieldAllowed(field)).toBe(true);
  });

  it('emits JSON without forbidden values and counts dropped fields', () => {
    const lines: string[] = [];
    const logger = createLogger('hsp-test', 'info', (l) => lines.push(l), () => new Date('2026-01-01T00:00:00Z'));
    logger.log('info', 'otp.sent', { phone: '+919876543210', otp: '123456', role: 'api' });
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('9876543210');
    expect(line).not.toContain('123456');
    expect(JSON.parse(line)).toMatchObject({ event: 'otp.sent', fields: { role: 'api' }, droppedFieldCount: 2 });
  });

  it('respects the minimum level and rejects free-text event names', () => {
    const lines: string[] = [];
    const logger = createLogger('hsp-test', 'warn', (l) => lines.push(l));
    logger.log('info', 'ignored.event');
    expect(lines).toHaveLength(0);
    expect(() => logger.log('error', 'User +91 98765 failed')).toThrow();
  });
});
