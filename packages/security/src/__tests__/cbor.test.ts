// Gate 3 review fixes: strict CBOR subset for WebAuthn (ADR-024 #2) and fail-closed rate-limit store selection.
import { describe, expect, it } from 'vitest';
import {
  assertRateLimitStore, CBOR_LIMITS, decodeCbor, decodeCborExact, MemoryRateLimitStore, RateLimitConfigError, WebAuthnError,
} from '../index.ts';

const hex = (h: string) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return e instanceof WebAuthnError ? e.code : `OTHER:${String(e)}`;
  }
};

describe('CBOR decoder (strict subset)', () => {
  it('decodes minimal encodings of the accepted types', () => {
    expect(decodeCborExact(hex('17'))).toBe(23);
    expect(decodeCborExact(hex('1818'))).toBe(24);
    expect(decodeCborExact(hex('190100'))).toBe(256);
    expect(decodeCborExact(hex('1a00010000'))).toBe(65536);
    expect(decodeCborExact(hex('1b0000000100000000'))).toBe(2 ** 32);
    expect(decodeCborExact(hex('26'))).toBe(-7);
    expect(decodeCborExact(hex('6161'))).toBe('a');
    expect(decodeCborExact(hex('62c3a9'))).toBe('é');
    expect(decodeCborExact(hex('a20102 6161 f5'))).toEqual(new Map<unknown, unknown>([[1, 2], ['a', true]]));
    expect(decodeCborExact(hex('83 f4 f6 4101'))).toEqual([false, null, Buffer.from([1])]);
  });

  it.each([
    ['integer 5 in one extra byte', '1805'], ['integer 255 in two bytes', '1900ff'], ['integer in four bytes < 2^16', '1a0000ffff'],
    ['integer in eight bytes < 2^32', '1b00000000ffffffff'], ['negative -1 in one extra byte', '3800'],
    ['byte-string length in one extra byte', '5801aa'], ['text length in two bytes', '79000161'],
    ['array length in one extra byte', '9800'], ['map length in one extra byte', 'b800'],
  ])('rejects non-minimal encoding: %s', (_name, input) => {
    expect(code(() => decodeCborExact(hex(input)))).toBe('CBOR_NON_MINIMAL');
  });

  it('rejects invalid UTF-8 (truncated sequence, overlong form, lone surrogate)', () => {
    for (const bad of ['62c328', '62c0af', '63eda080']) expect(code(() => decodeCborExact(hex(bad))), bad).toBe('CBOR_UTF8');
  });

  it('rejects duplicate keys (also across int / text forms of the same key), non-scalar keys', () => {
    expect(code(() => decodeCborExact(hex('a2 01 01 01 02')))).toBe('CBOR_DUPLICATE_KEY');
    expect(code(() => decodeCborExact(hex('a2 6161 01 6161 02')))).toBe('CBOR_DUPLICATE_KEY');
    expect(code(() => decodeCborExact(hex('a1 4101 01')))).toBe('CBOR_KEY');
    expect(code(() => decodeCborExact(hex('a1 f5 01')))).toBe('CBOR_KEY');
  });

  it('enforces size, item-count and depth limits', () => {
    expect(code(() => decodeCbor(Buffer.alloc(CBOR_LIMITS.maxBytes + 1, 0)))).toBe('CBOR_TOO_LARGE');
    const items = (n: number) => Buffer.concat([hex(n < 24 ? (0x80 + n).toString(16) : `98${n.toString(16).padStart(2, '0')}`), Buffer.alloc(n, 0)]);
    expect(code(() => decodeCborExact(items(64)))).toBe('OK');
    expect(code(() => decodeCborExact(items(65)))).toBe('CBOR_TOO_MANY_ITEMS');
    const nested = (d: number) => Buffer.concat([Buffer.alloc(d, 0x81), hex('00')]);
    expect(code(() => decodeCborExact(nested(8)))).toBe('OK');
    expect(code(() => decodeCborExact(nested(9)))).toBe('CBOR_DEPTH');
  });

  it('rejects truncation anywhere, and trailing bytes after the item', () => {
    for (const t of ['', '19', '1901', '43aabb', '6261', '82 01', 'a1 01', '5affffffff']) {
      expect(code(() => decodeCborExact(hex(t))), t).toBe('CBOR_TRUNCATED');
    }
    expect(code(() => decodeCborExact(hex('01 00')))).toBe('CBOR_TRAILING');
    expect(decodeCbor(hex('01 00')).end).toBe(1);
  });

  it('rejects indefinite lengths, tags, floats, other simple values, reserved info and out-of-range integers', () => {
    expect(code(() => decodeCborExact(hex('9fff')))).toBe('CBOR_INDEFINITE');
    expect(code(() => decodeCborExact(hex('5f41aaff')))).toBe('CBOR_INDEFINITE');
    expect(code(() => decodeCborExact(hex('c074323031332d30332d32315432303a30343a30305a')))).toBe('CBOR_TAG');
    expect(code(() => decodeCborExact(hex('f93c00')))).toBe('CBOR_FLOAT');
    expect(code(() => decodeCborExact(hex('fb3ff0000000000000')))).toBe('CBOR_FLOAT');
    expect(code(() => decodeCborExact(hex('f7')))).toBe('CBOR_UNSUPPORTED'); // undefined
    expect(code(() => decodeCborExact(hex('1c')))).toBe('CBOR_RESERVED');
    expect(code(() => decodeCborExact(hex('1b0020000000000000')))).toBe('CBOR_INT_RANGE');
    expect(code(() => decodeCborExact(hex('3b001fffffffffffff')))).toBe('CBOR_INT_RANGE');
  });
});

describe('rate-limit store selection fails closed', () => {
  const shared = { shared: true, take: async () => ({ allowed: true, retryAfterSec: 0 }) };
  it('requires a store, and a shared atomic one outside local / test', () => {
    expect(() => assertRateLimitStore(undefined, 'test')).toThrow(RateLimitConfigError);
    expect(() => assertRateLimitStore(undefined, 'staging')).toThrow(RateLimitConfigError);
    for (const env of ['dev', 'staging', 'prod', 'production', '']) expect(() => assertRateLimitStore(new MemoryRateLimitStore(), env), env).toThrow(RateLimitConfigError);
    for (const env of ['local', 'test']) expect(assertRateLimitStore(new MemoryRateLimitStore(), env).shared).toBe(false);
    expect(assertRateLimitStore(shared, 'staging')).toBe(shared);
  });
});
