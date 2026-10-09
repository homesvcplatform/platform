// @hsp/money: integer paise arithmetic (Phase 1 09 §9). All amounts are integer paise, rates are basis points, and
// quantities are thousandths ("milli", matching numeric(10,3) columns). Rounding is half-up on non-negative values,
// which is what PostgreSQL's round(numeric) does for them (the quote-item CHECK `amount = round(qty * unit)` relies on
// it). Splits use the largest-remainder method so the parts always sum exactly to the whole.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertNonNegativeInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyError(`${what} must be a non-negative safe integer`);
}

/** round(numerator / denominator), half-up, for non-negative integers (exact: BigInt intermediate). */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  assertNonNegativeInt(numerator, 'numerator');
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new MoneyError('denominator must be a positive safe integer');
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const r = (n * 2n + d) / (d * 2n);
  if (r > BigInt(MAX_SAFE)) throw new MoneyError('result out of range');
  return Number(r);
}

/** Quantity (up to 3 decimals) → thousandths; refuses more precision, negatives and non-finite values. */
export function toMilli(qty: number): number {
  if (!Number.isFinite(qty) || qty < 0) throw new MoneyError('quantity must be a non-negative finite number');
  const milli = Math.round(qty * 1000);
  if (Math.abs(milli - qty * 1000) > 1e-6) throw new MoneyError('quantity has more than 3 decimals');
  assertNonNegativeInt(milli, 'quantity');
  return milli;
}

/** Thousandths → decimal string with 3 places (what a numeric(10,3) column stores), e.g. 2500 → "2.500". */
export function milliToString(milli: number): string {
  assertNonNegativeInt(milli, 'quantity');
  return `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, '0')}`;
}

/** Line amount = round(qty × unit price), half-up (09 §9: checked by a DB constraint on quote items). */
export function lineAmount(qtyMilli: number, unitPaise: number): number {
  assertNonNegativeInt(qtyMilli, 'quantity');
  assertNonNegativeInt(unitPaise, 'unit price');
  const product = BigInt(qtyMilli) * BigInt(unitPaise);
  const r = (product * 2n + 1000n) / 2000n;
  if (r > BigInt(MAX_SAFE)) throw new MoneyError('amount out of range');
  return Number(r);
}

/** amount × bps / 10 000, half-up. */
export function applyBps(amountPaise: number, bps: number): number {
  assertNonNegativeInt(amountPaise, 'amount');
  assertNonNegativeInt(bps, 'bps');
  if (bps > 1_000_000) throw new MoneyError('bps out of range');
  const r = (BigInt(amountPaise) * BigInt(bps) * 2n + 10_000n) / 20_000n;
  if (r > BigInt(MAX_SAFE)) throw new MoneyError('amount out of range');
  return Number(r);
}

/**
 * Largest-remainder split of `total` by integer weights: every part is floor(total × w / Σw), and the paise left over go
 * one each to the parts with the largest fractional remainders (ties: the earlier part). Σ parts = total, always.
 */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  assertNonNegativeInt(total, 'total');
  if (weights.length === 0) throw new MoneyError('weights must not be empty');
  for (const w of weights) assertNonNegativeInt(w, 'weight');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new MoneyError('weights must not all be zero');
  const t = BigInt(total);
  const s = BigInt(sum);
  const exact = weights.map((w) => t * BigInt(w));
  const parts = exact.map((e) => e / s);
  const remainders = exact.map((e, i) => ({ i, r: e % s }));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts.map((p) => Number(p));
}

/** Two-way split of an amount by a basis-point share: [share, rest], exact (largest remainder). */
export function splitBps(amountPaise: number, shareBps: number): [number, number] {
  assertNonNegativeInt(shareBps, 'bps');
  if (shareBps > 10_000) throw new MoneyError('share bps above 10 000');
  if (shareBps === 0) return [0, amountPaise];
  if (shareBps === 10_000) return [amountPaise, 0];
  const [a, b] = largestRemainder(amountPaise, [shareBps, 10_000 - shareBps]);
  return [a ?? 0, b ?? 0];
}

/** "₹1,234.50" in the Indian digit grouping (display only; never parse this back). */
export function formatInr(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new MoneyError('paise must be a safe integer');
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}₹${rest ? `${rest},${last3}` : last3}.${String(abs % 100).padStart(2, '0')}`;
}
