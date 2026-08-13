/**
 * CLAUDE.md §17 — money is one of the four areas that gets ruthless testing.
 * These tests exist because a rounding error at scale is unrecoverable.
 */
import { describe, it, expect } from 'vitest';
import { money } from '@provia/types';
import { add, subtract, times, scale, allocate, clampToFloor, sum, discountPercent } from './money';

const ngn = (k: number) => money(k, 'NGN');

describe('money arithmetic', () => {
  it('adds within a currency', () => {
    expect(add(ngn(1000), ngn(500)).amount).toBe(1500);
  });

  it('refuses to mix currencies rather than silently converting', () => {
    expect(() => add(ngn(1000), money(500, 'USD'))).toThrow(/Currency mismatch/);
  });

  it('rejects a non-integer amount at construction', () => {
    expect(() => ngn(12.5)).toThrow(/integer in minor units/);
  });

  it('rejects fractional quantities', () => {
    expect(() => times(ngn(400), 2.5)).toThrow(/non-negative integer/);
  });
});

describe('scale', () => {
  it('rounds half-up, once', () => {
    // 40000 kobo * 1.15 = 46000 exactly
    expect(scale(ngn(40_000), 1.15).amount).toBe(46_000);
  });

  it('composing multipliers avoids the drift that chaining introduces', () => {
    // Wash+Iron (1.15) x Standard quality (1.2) on a 1002 kobo line.
    // Chaining rounds twice and lands a kobo low. Composing rounds once.
    // This is why CLAUDE.md says compose the multipliers, then scale once.
    const composed = scale(ngn(1002), 1.15 * 1.2).amount;
    const chained = scale(scale(ngn(1002), 1.15), 1.2).amount;
    expect(composed).toBe(1383);
    expect(chained).toBe(1382);
    expect(composed).not.toBe(chained);
  });
});

describe('allocate', () => {
  it('never loses or invents a kobo', () => {
    const parts = allocate(ngn(1000), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(sum(parts, 'NGN').amount).toBe(1000);
  });

  it('splits a commission exactly', () => {
    const parts = allocate(ngn(299_401), [88, 12]);
    expect(sum(parts, 'NGN').amount).toBe(299_401);
  });
});

describe('margin floor', () => {
  it('clamps and reports when a discount would breach the floor', () => {
    const discounted = discountPercent(ngn(10_000), 90);
    const { value, clamped } = clampToFloor(discounted, ngn(5_000));
    expect(clamped).toBe(true);
    expect(value.amount).toBe(5_000);
  });

  it('leaves a healthy price alone', () => {
    const { value, clamped } = clampToFloor(ngn(9_000), ngn(5_000));
    expect(clamped).toBe(false);
    expect(value.amount).toBe(9_000);
  });
});

describe('subtract', () => {
  it('permits negative results for ledger corrections', () => {
    expect(subtract(ngn(500), ngn(800)).amount).toBe(-300);
  });
});
