/**
 * packages/core/money.ts
 *
 * The only place in the codebase allowed to do arithmetic on money.
 * Everything else imports from here.
 *
 * Why this file exists: a rounding error at scale is an unrecoverable
 * reconciliation crisis. Making floats a type error is cheaper than auditing
 * for them later.
 *
 * HUMAN REVIEW REQUIRED on any change to this file.
 */

import { Money, CurrencyCode, minorUnits, money } from '@provia/types';

export { money, minorUnits };

/** Minor units per major unit. NGN and most others are 100. */
const MINOR_PER_MAJOR: Record<CurrencyCode, number> = {
  NGN: 100,
  GHS: 100,
  KES: 100,
  AED: 100,
  EUR: 100,
  USD: 100,
};

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Currency mismatch: ${a.currency} vs ${b.currency}. ` +
        `Conversion must be explicit and go through the FX boundary.`,
    );
  }
};

export const zero = (currency: CurrencyCode): Money => money(0, currency);

export const add = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return { amount: minorUnits(a.amount + b.amount), currency: a.currency };
};

export const subtract = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return { amount: minorUnits(a.amount - b.amount), currency: a.currency };
};

export const sum = (items: readonly Money[], currency: CurrencyCode): Money =>
  items.reduce<Money>((acc, m) => add(acc, m), zero(currency));

/**
 * Multiply by a quantity. Quantity must be a whole number — you cannot buy
 * 2.5 shirts.
 */
export const times = (m: Money, quantity: number): Money => {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`Quantity must be a non-negative integer, received ${String(quantity)}`);
  }
  return { amount: minorUnits(m.amount * quantity), currency: m.currency };
};

/**
 * Apply a multiplier such as a treatment or quality factor.
 *
 * Rounding is HALF-UP and applied once, at the end. Never chain scale() calls
 * on an already-rounded value — compose the multipliers first, then scale once,
 * or you will accumulate rounding drift across a basket.
 */
export const scale = (m: Money, multiplier: number): Money => {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new TypeError(`Multiplier must be a finite non-negative number, received ${String(multiplier)}`);
  }
  return {
    amount: minorUnits(Math.round(m.amount * multiplier)),
    currency: m.currency,
  };
};

/** Apply a percentage discount. `percent` is 0–100. */
export const discountPercent = (m: Money, percent: number): Money => {
  if (percent < 0 || percent > 100) {
    throw new RangeError(`Discount percent must be between 0 and 100, received ${String(percent)}`);
  }
  return scale(m, (100 - percent) / 100);
};

/** Never let a value fall below a floor. Returns the floor and a flag. */
export const clampToFloor = (m: Money, floor: Money): { value: Money; clamped: boolean } => {
  assertSameCurrency(m, floor);
  return m.amount < floor.amount
    ? { value: floor, clamped: true }
    : { value: m, clamped: false };
};

export const isZero = (m: Money): boolean => m.amount === 0;
export const isNegative = (m: Money): boolean => m.amount < 0;

export const compare = (a: Money, b: Money): -1 | 0 | 1 => {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
};

export const gte = (a: Money, b: Money): boolean => compare(a, b) >= 0;

/**
 * Split an amount across n parts without losing or inventing a single kobo.
 * Remainder is distributed one unit at a time to the earliest parts.
 *
 * Used for commission splits and multi-partner settlement. Naive division here
 * is how platforms end up a few kobo out on every order, which becomes a real
 * number at a million orders.
 */
export const allocate = (m: Money, ratios: readonly number[]): Money[] => {
  const totalRatio = ratios.reduce((a, b) => a + b, 0);
  if (totalRatio <= 0) throw new RangeError('Allocation ratios must sum to more than zero');

  const parts: number[] = ratios.map((r) => Math.floor((m.amount * r) / totalRatio));
  let remainder = m.amount - parts.reduce((a, b) => a + b, 0);

  for (let i = 0; remainder > 0; i = (i + 1) % parts.length, remainder--) {
    parts[i] = (parts[i] ?? 0) + 1;
  }
  return parts.map((amount) => ({ amount: minorUnits(amount), currency: m.currency }));
};

/**
 * Display only. Never round-trip a formatted string back into Money.
 * Formatting lives at the edge; arithmetic never touches a string.
 */
export const format = (m: Money, locale = 'en-NG'): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(m.amount / MINOR_PER_MAJOR[m.currency]);

/** Parse a major-unit input from a form. Rejects anything with sub-kobo precision. */
export const fromMajor = (major: number, currency: CurrencyCode): Money => {
  const minor = major * MINOR_PER_MAJOR[currency];
  if (!Number.isInteger(Math.round(minor * 1000) / 1000) || !Number.isInteger(Math.round(minor))) {
    throw new TypeError(`${String(major)} ${currency} has more precision than the currency supports`);
  }
  return money(Math.round(minor), currency);
};
