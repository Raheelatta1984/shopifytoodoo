/**
 * Money handling.
 *
 * Every monetary value in the pipeline is carried around as an integer amount
 * of the currency's minor unit (cents for AUD/USD/...).  This removes binary
 * floating point drift from totals, discounts and tax allocations, which is a
 * hard requirement for reconciling against Shopify's own totals
 * (REQ-005 / EV-734D618CA "It should download the shopify order 100%").
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);

/** Number of decimal places used by the currency. */
export function currencyExponent(currency: string | undefined | null): number {
  if (!currency) return 2;
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Convert a decimal amount (string or number) into integer minor units.
 * Rounding is half-away-from-zero, matching Shopify's behaviour.
 */
export function toMinor(value: unknown, currency?: string | null): number {
  if (value === null || value === undefined || value === '') return 0;
  const exp = currencyExponent(currency);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return roundHalfAway(value * 10 ** exp);
  }
  if (typeof value !== 'string') return 0;
  const raw = value.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? roundHalfAway(parsed * 10 ** exp) : 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const intPart = match[2] || '0';
  const fracPart = match[3] || '';
  const kept = fracPart.slice(0, exp).padEnd(exp, '0');
  const nextDigit = fracPart.length > exp ? Number(fracPart.charAt(exp)) : 0;
  let minor = Number(intPart) * 10 ** exp + (kept === '' ? 0 : Number(kept));
  if (nextDigit >= 5) minor += 1;
  return sign * minor;
}

/** Convert integer minor units back into a fixed decimal string. */
export function fromMinor(minor: number, currency?: string | null): string {
  const exp = currencyExponent(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  if (exp === 0) return `${negative ? '-' : ''}${abs}`;
  const factor = 10 ** exp;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(exp, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Numeric value (major units) of an integer minor amount. */
export function toMajor(minor: number, currency?: string | null): number {
  return Number(fromMinor(minor, currency));
}

export function roundHalfAway(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? -Math.round(Math.abs(value)) : Math.round(value);
}

/** Multiply a minor amount by a (possibly fractional) quantity. */
export function multiplyMinor(minor: number, quantity: number): number {
  return roundHalfAway(minor * quantity);
}

/**
 * Distribute `total` minor units across `weights` proportionally, keeping the
 * sum of the allocation exactly equal to `total` (largest remainder method).
 * Used to spread order-level discounts over the order lines deterministically.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    // Nothing to weight against: give everything to the first bucket.
    const result = new Array<number>(weights.length).fill(0);
    result[0] = total;
    return result;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = total - floored.reduce((acc, v) => acc + v, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const result = [...floored];
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const target = order[cursor % order.length]!.index;
    result[target] = (result[target] ?? 0) + 1;
    remainder -= 1;
    cursor += 1;
  }
  while (remainder < 0 && order.length > 0) {
    const target = order[cursor % order.length]!.index;
    result[target] = (result[target] ?? 0) - 1;
    remainder += 1;
    cursor += 1;
  }
  return result;
}

/** Percentage of an amount, rounded to the nearest minor unit. */
export function percentOf(amount: number, percentage: number): number {
  return roundHalfAway((amount * percentage) / 100);
}
