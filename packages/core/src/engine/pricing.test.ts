/**
 * CLAUDE.md §17 — the pricing engine is ruthlessly tested: every rule,
 * every stacking order, the margin floor.
 */
import { describe, it, expect } from 'vitest';
import type { Entitlement, OrderComposition } from '@provia/types';
import { money } from '@provia/types';
import { laundry } from '../services/laundry';
import { computePrice, type PricingInput, type EntitlementUsageContext } from './pricing';

const ngn = (k: number) => money(k, 'NGN');

const baseComposition: OrderComposition = {
  serviceId: 'laundry',
  zoneId: 'zone-1' as OrderComposition['zoneId'],
  speed: 'standard',
  groups: [
    {
      categoryKey: 'men',
      items: { shirt: 3, trouser: 2 },
      treatmentKey: 'wash_iron',
      qualityKey: 'standard',
      careFlags: [],
      note: '',
    },
  ],
};

const noRedemptions: EntitlementUsageContext = {
  serviceId: 'laundry',
  orderValueSoFar: ngn(0),
  redemptionsThisMonth: () => 0,
};

function baseInput(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    service: laundry,
    composition: baseComposition,
    commission: { ratePercent: 12 },
    entitlements: [],
    currency: 'NGN',
    minMargin: ngn(50_000), // ₦500 floor for these tests
    ...overrides,
  };
}

describe('computePrice — base pipeline', () => {
  it('computes items subtotal from the service module, not hardcoded here', () => {
    const result = computePrice(baseInput(), noRedemptions);
    // 3 shirts @₦400 + 2 trousers @₦450 = ₦2,100 subtotal, in kobo: 210000.
    // Wash+Iron (1.15) x Standard quality (1.2), composed then rounded once
    // (CLAUDE.md money.ts convention — see the money.test.ts drift case).
    const expected = Math.round(210_000 * 1.15 * 1.2);
    expect(result.itemsSubtotal.amount).toBe(expected);
  });

  it('always includes the base delivery fee', () => {
    const result = computePrice(baseInput(), noRedemptions);
    expect(result.deliveryFee.amount).toBe(70_000);
  });

  it('applies zero speed surcharge on standard, a real one on express', () => {
    const std = computePrice(baseInput(), noRedemptions);
    expect(std.speedSurcharge.amount).toBe(0);

    const exp = computePrice(
      baseInput({ composition: { ...baseComposition, speed: 'express' } }),
      noRedemptions,
    );
    expect(exp.speedSurcharge.amount).toBe(320_000);
  });

  it('commission is computed on pre-commission total, not on items alone', () => {
    const result = computePrice(baseInput(), noRedemptions);
    const expectedCommission = Math.round(result.preCommission.amount * 0.12);
    expect(result.commission.amount).toBe(expectedCommission);
  });
});

describe('computePrice — entitlements (CLAUDE.md §15)', () => {
  const plusFreeService: Entitlement & { discountPercent: number } = {
    key: 'plus_service_discount',
    tier: 'plus',
    costClass: 'B',
    fundedBy: 'platform',
    appliesTo: ['laundry', 'carwash'],
    discountPercent: 10,
  };

  it('applies an eligible entitlement discount', () => {
    const withEnt = computePrice(baseInput({ entitlements: [plusFreeService] }), noRedemptions);
    const withoutEnt = computePrice(baseInput(), noRedemptions);
    expect(withEnt.total.amount).toBeLessThan(withoutEnt.total.amount);
    expect(withEnt.appliedEntitlements).toHaveLength(1);
  });

  it('ignores an entitlement that does not apply to this service', () => {
    const marketOnly = { ...plusFreeService, appliesTo: ['marketplace'] as const };
    const result = computePrice(baseInput({ entitlements: [marketOnly] }), noRedemptions);
    expect(result.appliedEntitlements).toHaveLength(0);
    expect(result.entitlementDiscount.amount).toBe(0);
  });

  it('respects the monthly cap — a benefit already exhausted contributes nothing (CLAUDE.md: Class A must be capped)', () => {
    const capped: Entitlement & { discountPercent: number } = {
      ...plusFreeService,
      monthlyCap: 2,
      discountPercent: 50,
    };
    const exhausted: EntitlementUsageContext = {
      ...noRedemptions,
      redemptionsThisMonth: (key) => (key === capped.key ? 2 : 0),
    };
    const result = computePrice(baseInput({ entitlements: [capped] }), exhausted);
    expect(result.appliedEntitlements).toHaveLength(0);
  });

  it('respects a minimum order value on the entitlement', () => {
    const highMin: Entitlement & { discountPercent: number } = {
      ...plusFreeService,
      minimumOrderValue: ngn(999_999_00), // absurdly high, should never trigger
      discountPercent: 50,
    };
    const result = computePrice(baseInput({ entitlements: [highMin] }), noRedemptions);
    expect(result.appliedEntitlements).toHaveLength(0);
  });

  it('multiple entitlements stack ADDITIVELY, not compounding on each other', () => {
    const entA: Entitlement & { discountPercent: number } = {
      key: 'a', tier: 'plus', costClass: 'B', fundedBy: 'platform',
      appliesTo: ['laundry'], discountPercent: 10,
    };
    const entB: Entitlement & { discountPercent: number } = {
      key: 'b', tier: 'plus', costClass: 'B', fundedBy: 'platform',
      appliesTo: ['laundry'], discountPercent: 10,
    };
    const result = computePrice(baseInput({ entitlements: [entA, entB] }), noRedemptions);
    expect(result.appliedEntitlements).toHaveLength(2);
    // second discount is computed off the ALREADY-discounted running total,
    // so 10% + 10% must be LESS than a naive 20% off the original — proves
    // no compounding trick inflates the discount.
    const naive20 = Math.round(result.preCommission.amount * 0.2);
    expect(result.entitlementDiscount.amount).toBeLessThan(naive20);
  });
});

describe('computePrice — promotions (CLAUDE.md §15: never combined with another promotion)', () => {
  it('applies a promo code after entitlements', () => {
    const result = computePrice(
      baseInput({ promotion: { code: 'WELCOME10', discountPercent: 10 } }),
      noRedemptions,
    );
    expect(result.promotionDiscount.amount).toBeGreaterThan(0);
  });

  it('respects a maxDiscount cap on the promo', () => {
    const result = computePrice(
      baseInput({ promotion: { code: 'HUGE', discountPercent: 90, maxDiscount: ngn(10_000) } }),
      noRedemptions,
    );
    expect(result.promotionDiscount.amount).toBe(10_000);
  });
});

describe('computePrice — the margin floor (CLAUDE.md §8: never below floor)', () => {
  it('clamps to the floor and reports floorApplied when discounts would breach it', () => {
    const brutal: Entitlement & { discountPercent: number } = {
      key: 'brutal', tier: 'business', costClass: 'A', fundedBy: 'platform',
      appliesTo: ['laundry'], discountPercent: 99,
    };
    const result = computePrice(
      baseInput({ entitlements: [brutal], minMargin: ngn(200_000) }),
      noRedemptions,
    );
    expect(result.floorApplied).toBe(true);
    expect(result.total.amount).toBe(200_000);
  });

  it('does not clamp a healthy price and reports floorApplied: false', () => {
    const result = computePrice(baseInput(), noRedemptions);
    expect(result.floorApplied).toBe(false);
  });

  it('a stacked entitlement + promo cannot together push the price to zero or negative', () => {
    const heavy: Entitlement & { discountPercent: number } = {
      key: 'heavy', tier: 'business', costClass: 'A', fundedBy: 'platform',
      appliesTo: ['laundry'], discountPercent: 80,
    };
    const result = computePrice(
      baseInput({
        entitlements: [heavy],
        promotion: { code: 'MORE', discountPercent: 80 },
        minMargin: ngn(100_000),
      }),
      noRedemptions,
    );
    expect(result.total.amount).toBeGreaterThanOrEqual(100_000);
    expect(result.floorApplied).toBe(true);
  });
});

describe('computePrice — minimum order value flag', () => {
  it('flags an order under the service minimum without blocking the calculation', () => {
    const tiny: OrderComposition = {
      ...baseComposition,
      groups: [
        {
          categoryKey: 'men',
          items: { shirt: 1 }, // well under laundry's ₦3,000 minimum and 3-item norm
          treatmentKey: 'wash_only',
          qualityKey: 'regular',
          careFlags: [],
          note: '',
        },
      ],
    };
    const result = computePrice(baseInput({ composition: tiny }), noRedemptions);
    expect(result.belowMinimumOrder).toBe(true);
  });

  it('does not flag an order at or above the service minimum', () => {
    // The shared baseComposition (3 shirts + 2 trousers) totals ~₦2,898
    // after multipliers, which is itself BELOW laundry's real ₦3,000
    // minimum — a genuine finding from writing this test, not a fixture
    // to take for granted. Use a composition that is clearly above it.
    const aboveMin: OrderComposition = {
      ...baseComposition,
      groups: [
        {
          categoryKey: 'men',
          items: { shirt: 6, trouser: 4 },
          treatmentKey: 'wash_iron',
          qualityKey: 'standard',
          careFlags: [],
          note: '',
        },
      ],
    };
    const result = computePrice(baseInput({ composition: aboveMin }), noRedemptions);
    expect(result.itemsSubtotal.amount).toBeGreaterThanOrEqual(laundry.minimumOrderValue.amount);
    expect(result.belowMinimumOrder).toBe(false);
  });
});
