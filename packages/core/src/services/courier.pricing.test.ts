/**
 * CLAUDE.md §17 — pricing tests for the second service. Courier has no
 * treatment/quality multiplier, so these tests exist mainly to prove the
 * flat per-tier pricing and vehicle rule are correct, and that the shared
 * pricing.ts pipeline (CLAUDE.md §8's fixed order) works identically for
 * a service whose priceItems() shape is simpler than laundry's.
 */
import { describe, it, expect } from 'vitest';
import type { OrderComposition } from '@provia/types';
import { courier } from './courier';
import { computePrice, type PricingInput, type EntitlementUsageContext } from '../engine/pricing';

const noRedemptions: EntitlementUsageContext = {
  serviceId: 'courier',
  orderValueSoFar: { amount: 0 as never, currency: 'NGN' },
  redemptionsThisMonth: () => 0,
};

function composition(items: Record<string, number>): OrderComposition {
  return {
    serviceId: 'courier',
    zoneId: 'zone-1' as OrderComposition['zoneId'],
    speed: 'standard',
    groups: [{ categoryKey: 'parcel', items, treatmentKey: 'n/a', qualityKey: 'n/a', careFlags: [], note: '' }],
  };
}

function baseInput(items: Record<string, number>): PricingInput {
  return {
    service: courier,
    composition: composition(items),
    commission: { ratePercent: 15 },
    entitlements: [],
    currency: 'NGN',
    minMargin: { amount: 50_000 as never, currency: 'NGN' },
  };
}

describe('courier.priceItems — flat per-tier pricing, no multipliers', () => {
  it('prices a single documents parcel at exactly its listed price', () => {
    const result = computePrice(baseInput({ documents: 1 }), noRedemptions);
    expect(result.itemsSubtotal.amount).toBe(150_000);
  });

  it('prices multiple parcels of the same tier linearly, no discount', () => {
    const result = computePrice(baseInput({ small: 3 }), noRedemptions);
    expect(result.itemsSubtotal.amount).toBe(250_000 * 3);
  });

  it('sums mixed tiers correctly', () => {
    const result = computePrice(baseInput({ documents: 1, medium: 1 }), noRedemptions);
    expect(result.itemsSubtotal.amount).toBe(150_000 + 450_000);
  });
});

describe('courier.vehicleRule', () => {
  it('sends documents and small parcels on a bike', () => {
    expect(courier.vehicleRule(composition({ documents: 2 }))).toBe('ev_bike');
    expect(courier.vehicleRule(composition({ small: 1 }))).toBe('ev_bike');
  });

  it('sends medium and large/bulky parcels on a van', () => {
    expect(courier.vehicleRule(composition({ medium: 1 }))).toBe('ev_van');
    expect(courier.vehicleRule(composition({ large_bulky: 1 }))).toBe('ev_van');
  });

  it('one large item in a mixed order still requires the van', () => {
    expect(courier.vehicleRule(composition({ documents: 3, large_bulky: 1 }))).toBe('ev_van');
  });

  it('a high volume of small parcels needs a van even with no single large item', () => {
    expect(courier.vehicleRule(composition({ documents: 5 }))).toBe('ev_bike'); // under threshold
    expect(courier.vehicleRule(composition({ documents: 11 }))).toBe('ev_van'); // over threshold
  });
});

describe('courier.minimumOrderValue', () => {
  it('the cheapest real order (one document) clears the floor on its own', () => {
    expect(150_000).toBeGreaterThanOrEqual(courier.minimumOrderValue.amount);
  });

  it('computePrice flags nothing below minimum for a real single-document order', () => {
    const result = computePrice(baseInput({ documents: 1 }), noRedemptions);
    expect(result.belowMinimumOrder).toBe(false);
  });
});

describe('courier — commission and margin floor still apply identically to laundry', () => {
  it('commission is computed on the pre-commission total, same pipeline as laundry', () => {
    const result = computePrice(baseInput({ medium: 1 }), noRedemptions);
    const expectedCommission = Math.round(result.preCommission.amount * 0.15);
    expect(result.commission.amount).toBe(expectedCommission);
  });

  it('a large discount still cannot push the price below the floor', () => {
    const heavy = {
      key: 'heavy', tier: 'business' as const, costClass: 'A' as const, fundedBy: 'platform' as const,
      appliesTo: ['courier' as const], discountPercent: 95,
    };
    const result = computePrice(
      { ...baseInput({ documents: 1 }), entitlements: [heavy], minMargin: { amount: 100_000 as never, currency: 'NGN' } },
      noRedemptions,
    );
    expect(result.floorApplied).toBe(true);
    expect(result.total.amount).toBe(100_000);
  });
});
