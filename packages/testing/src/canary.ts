// Canary-PII scanner (Phase 1 11 §2.1, 13 ST-30): flows run with recognisable canary values; afterwards every captured
// log line, audit row and error body is scanned. Any hit means personal data or a secret leaked. Synthetic only.
export const CANARY = {
  phone: '+910000099871',
  phoneDigits: '0000099871',
  name: 'Canaryqz Testperson',
  address: 'Canary Lane 77 Zqx',
} as const;

/** Returns the canary values found in `haystacks` (plus any extra secrets the test registers, e.g. OTP codes, tokens). */
export function findCanaries(haystacks: readonly string[], extraSecrets: readonly string[] = []): string[] {
  const needles = [...Object.values(CANARY), ...extraSecrets].filter((n) => n.length >= 6);
  const text = haystacks.join('\n');
  return needles.filter((n) => text.includes(n));
}
