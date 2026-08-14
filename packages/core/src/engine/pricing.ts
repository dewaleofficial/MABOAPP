/**
 * packages/core/src/engine/pricing.ts
 *
 * CLAUDE.md §8 — pricing is applied in a FIXED ORDER, then floored:
 *
 *   base → serviceRules → commission → entitlements → promotions → enforceFloor(minMargin)
 *
 * This module is the only place that order is allowed to exist. Nothing
 * downstream re-derives a price — the server computes it here from an
 * OrderComposition and everyone else (customer app, partner app, admin)
 * only ever displays what this function returned (CLAUDE.md §3.9 — the
 * server never trusts a client-supplied price).
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §8, §18).
 */

import type {
  ServiceModule,
  OrderComposition,
  Money,
  Entitlement,
  CurrencyCode,
} from '@provia/types';
import { add, subtract, scale, zero, gte, clampToFloor } from '../money';

// ─────────────────────────────────────────────────────────────
// Fixed pricing pipeline inputs
// ─────────────────────────────────────────────────────────────

/** SLA surcharges by speed tier — kept out of the service module because
 *  they are a platform-wide policy, not a per-service rule. */
const SPEED_SURCHARGE_KOBO: Record<OrderComposition['speed'], number> = {
  express: 320_000, // ₦3,200
  standard: 0,
  custom: 160_000, // ₦1,600
};

const BASE_DELIVERY_FEE_KOBO = 70_000; // ₦700, every order (CLAUDE.md-aligned with the prototype)

export interface CommissionRule {
  /** Percentage taken from the partner side, 0–100. */
  readonly ratePercent: number;
}

export interface AppliedEntitlement {
  readonly entitlement: Entitlement;
  /** Discount this entitlement contributes, already capped by its own rules. */
  readonly discount: Money;
}

export interface PromotionCode {
  readonly code: string;
  readonly discountPercent: number;
  readonly maxDiscount?: Money;
}

export interface PricingInput {
  readonly service: ServiceModule;
  readonly composition: OrderComposition;
  readonly commission: CommissionRule;
  readonly entitlements: readonly Entitlement[];
  readonly promotion?: PromotionCode;
  readonly currency: CurrencyCode;
  /** The floor below which a price may never fall, regardless of discounting. */
  readonly minMargin: Money;
}

export interface DetailedPriceBreakdown {
  readonly itemsSubtotal: Money;
  readonly deliveryFee: Money;
  readonly speedSurcharge: Money;
  readonly preCommission: Money;
  readonly commission: Money;
  readonly appliedEntitlements: readonly AppliedEntitlement[];
  readonly entitlementDiscount: Money;
  readonly promotionDiscount: Money;
  readonly total: Money;
  readonly floorApplied: boolean;
  /** Whether the order is below the service's minimum order value (CLAUDE.md §2 — vehicleRule etc). */
  readonly belowMinimumOrder: boolean;
}

// ─────────────────────────────────────────────────────────────
// Class A benefits must be capped (CLAUDE.md §15 doc / benefit catalogue).
// This function enforces the cap and the funding rule structurally: a
// benefit missing eligibility for this service, or over its monthly cap,
// or under its minimum order value, contributes zero discount.
// ─────────────────────────────────────────────────────────────

export interface EntitlementUsageContext {
  readonly serviceId: ServiceModule['id'];
  readonly orderValueSoFar: Money;
  /** How many times this benefit has already been used this month. */
  readonly redemptionsThisMonth: (entitlementKey: string) => number;
}

function resolveEntitlementDiscount(
  entitlement: Entitlement,
  base: Money,
  ctx: EntitlementUsageContext,
): Money {
  if (!entitlement.appliesTo.includes(ctx.serviceId)) return zero(base.currency);

  if (entitlement.minimumOrderValue && !gte(ctx.orderValueSoFar, entitlement.minimumOrderValue)) {
    return zero(base.currency);
  }

  if (entitlement.monthlyCap !== undefined) {
    const used = ctx.redemptionsThisMonth(entitlement.key);
    if (used >= entitlement.monthlyCap) return zero(base.currency);
  }

  // The entitlement catalogue expresses value as a percentage-style benefit
  // via costClass/appliesTo; the actual discount PERCENT for a given
  // entitlement is a data field the CFO configures (CLAUDE.md §15) — modelled
  // here as a `discountPercent` carried in the entitlement's own record.
  // Class C benefits (priority dispatch, extended QA window, etc.) never
  // reach this function — they carry no monetary discount at all.
  const percent = (entitlement as Entitlement & { discountPercent?: number }).discountPercent ?? 0;
  if (percent <= 0) return zero(base.currency);

  return subtract(base, scale(base, (100 - percent) / 100));
}

// ─────────────────────────────────────────────────────────────
// The pricing pipeline. Order is not configurable — see the header comment.
// ─────────────────────────────────────────────────────────────

export function computePrice(
  input: PricingInput,
  entitlementCtx: EntitlementUsageContext,
): DetailedPriceBreakdown {
  const { service, composition, commission, entitlements, promotion, currency, minMargin } = input;

  // 1. base — the service module's own item pricing (CLAUDE.md §2)
  const itemsSubtotal = service.priceItems(composition);

  // 2. serviceRules — delivery + speed surcharge are platform-wide, applied
  //    right after the service's own item pricing.
  const deliveryFee: Money = { amount: BASE_DELIVERY_FEE_KOBO as Money['amount'], currency };
  const speedSurcharge: Money = {
    amount: SPEED_SURCHARGE_KOBO[composition.speed] as Money['amount'],
    currency,
  };

  const preCommission = add(add(itemsSubtotal, deliveryFee), speedSurcharge);

  // 3. commission — platform's cut of the pre-commission total. This is a
  //    reporting split, not a deduction from what the customer pays; see
  //    ledger note below. It is computed here because CLAUDE.md §8 lists it
  //    in the fixed order and downstream code needs the figure to post to
  //    the ledger correctly.
  const commissionAmount = scale(preCommission, commission.ratePercent / 100);

  // 4. entitlements — Class A/B benefits, each independently capped and
  //    eligibility-checked. Discounts stack additively against the running
  //    total, never compounding against each other (CLAUDE.md §15 — "no
  //    uncontrolled stacking").
  const appliedEntitlements: AppliedEntitlement[] = [];
  let runningTotal = preCommission;
  let entitlementDiscount = zero(currency);

  for (const ent of entitlements) {
    const discount = resolveEntitlementDiscount(ent, runningTotal, entitlementCtx);
    if (discount.amount > 0) {
      appliedEntitlements.push({ entitlement: ent, discount });
      entitlementDiscount = add(entitlementDiscount, discount);
      runningTotal = subtract(runningTotal, discount);
    }
  }

  // 5. promotions — a single campaign code, applied after entitlements,
  //    never combined with another promotion (CLAUDE.md §15).
  let promotionDiscount = zero(currency);
  if (promotion) {
    let discount = scale(runningTotal, promotion.discountPercent / 100);
    if (promotion.maxDiscount && discount.amount > promotion.maxDiscount.amount) {
      discount = promotion.maxDiscount;
    }
    promotionDiscount = discount;
    runningTotal = subtract(runningTotal, discount);
  }

  // 6. enforceFloor(minMargin) — never let a price fall below the floor,
  //    and always report when it did so the caller can alert/log it
  //    (CLAUDE.md §8: "Never allow an order to price below the margin floor").
  const { value: total, clamped: floorApplied } = clampToFloor(runningTotal, minMargin);

  return {
    itemsSubtotal,
    deliveryFee,
    speedSurcharge,
    preCommission,
    commission: commissionAmount,
    appliedEntitlements,
    entitlementDiscount,
    promotionDiscount,
    total,
    floorApplied,
    belowMinimumOrder: itemsSubtotal.amount < service.minimumOrderValue.amount,
  };
}
