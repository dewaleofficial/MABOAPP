/**
 * @provia/types — the single source of truth for domain contracts.
 *
 * Imported by apps/api, apps/customer, apps/partner, apps/web and packages/core.
 * If a change here breaks a build somewhere, that is the point.
 *
 * Rules encoded structurally in this file:
 *   - money cannot be a float          (Money is a branded integer + currency)
 *   - money cannot be currency-less    (Money requires a currency code)
 *   - order state cannot be mutated    (state is derived from events)
 *   - services cannot branch the spine (behaviour lives in ServiceModule)
 */

// ─────────────────────────────────────────────────────────────
// Branded primitives
// ─────────────────────────────────────────────────────────────

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** Integer count of the currency's minor unit (kobo, cent, fils). Never a float. */
export type MinorUnits = Brand<number, 'MinorUnits'>;

/** UTC instant, ISO-8601 with offset. Never a naive local datetime. */
export type UtcTimestamp = Brand<string, 'UtcTimestamp'>;

export type OrderId = Brand<string, 'OrderId'>;
export type PartnerId = Brand<string, 'PartnerId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type ZoneId = Brand<string, 'ZoneId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

/** Constructors are the only way to make a branded value. */
export const minorUnits = (n: number): MinorUnits => {
  if (!Number.isInteger(n)) {
    throw new TypeError(`Money must be an integer in minor units, received ${String(n)}`);
  }
  return n as MinorUnits;
};

export const utc = (d: Date | string): UtcTimestamp =>
  (typeof d === 'string' ? new Date(d) : d).toISOString() as UtcTimestamp;

// ─────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────

/** Expand as markets open. Never widen to `string`. */
export type CurrencyCode = 'NGN' | 'GHS' | 'KES' | 'AED' | 'EUR' | 'USD';

export interface Money {
  readonly amount: MinorUnits;
  readonly currency: CurrencyCode;
}

export const money = (amount: number, currency: CurrencyCode): Money => ({
  amount: minorUnits(amount),
  currency,
});

/** Arithmetic refuses to mix currencies rather than silently converting. */
export const addMoney = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot add ${a.currency} to ${b.currency} without an explicit FX step`);
  }
  return { amount: minorUnits(a.amount + b.amount), currency: a.currency };
};

// ─────────────────────────────────────────────────────────────
// Services
// ─────────────────────────────────────────────────────────────

export type ServiceId = 'laundry' | 'carwash' | 'marketplace' | 'cleaning' | 'courier';

export type CapacityUnit = 'orders_per_day' | 'bays_per_hour' | 'crews_per_day' | 'jobs_per_day';

export type VehicleClass = 'ev_bike' | 'ev_van' | 'none';

export interface ItemType {
  readonly key: string;
  readonly label: string;
  readonly emoji: string;
  readonly unitPrice: Money;
}

export interface ItemCategory {
  readonly key: string;
  readonly label: string;
  readonly emoji: string;
  readonly items: readonly ItemType[];
}

export interface QaCheck {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
}

export interface MilestoneSpec {
  readonly key: string;
  readonly label: string;
  readonly actor: 'customer' | 'partner_facility' | 'partner_logistics' | 'system';
  /** A handoff code that must be entered before this milestone can complete. */
  readonly requiresCode?: HandoffCodeKind;
  /** Evidence photos required at this milestone. */
  readonly evidenceCount?: number;
}

export interface EvidenceSpec {
  readonly atMilestone: string;
  readonly minPhotos: number;
  readonly requireGpsWithinMetres: number;
  readonly maxAgeSeconds: number;
}

/**
 * Everything a service is allowed to customise.
 * If behaviour is not expressible here, it belongs in the spine — not in an
 * `if (service === ...)` branch.
 */
export interface ServiceModule {
  readonly id: ServiceId;
  readonly label: string;
  readonly categories: readonly ItemCategory[];
  readonly milestones: readonly MilestoneSpec[];
  readonly facilityQa: readonly QaCheck[];
  readonly logisticsQa: readonly QaCheck[];
  readonly capacityUnit: CapacityUnit;
  readonly evidence: readonly EvidenceSpec[];
  /** Minimum order value. Protects unit economics against small orders. */
  readonly minimumOrderValue: Money;
  /** Chooses a vehicle from the order contents. Pure — no I/O. */
  readonly vehicleRule: (order: OrderComposition) => VehicleClass;
  /** Computes the goods/service subtotal. Pure — fees and discounts come later. */
  readonly priceItems: (order: OrderComposition) => Money;
}

// ─────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────

export type SpeedTier = 'express' | 'standard' | 'custom';

export interface OrderGroup {
  readonly categoryKey: string;
  readonly items: Readonly<Record<string, number>>;
  readonly treatmentKey: string;
  readonly qualityKey: string;
  readonly careFlags: readonly string[];
  readonly note: string;
}

/** What the customer built. Service-specific detail lives here, not in columns. */
export interface OrderComposition {
  readonly serviceId: ServiceId;
  readonly groups: readonly OrderGroup[];
  readonly speed: SpeedTier;
  readonly zoneId: ZoneId;
}

/**
 * Order state is DERIVED. There is no setter.
 * The only way to change an order is to append an OrderEvent.
 */
export interface OrderState {
  readonly id: OrderId;
  readonly serviceId: ServiceId;
  readonly customerId: CustomerId;
  readonly facilityPartnerId?: PartnerId;
  readonly logisticsPartnerId?: PartnerId;
  readonly zoneId: ZoneId;
  readonly milestoneIndex: number;
  readonly composition: OrderComposition;
  readonly total: Money;
  readonly createdAt: UtcTimestamp;
}

export type OrderEventType =
  | 'order.placed'
  | 'order.paid'
  | 'partner.assigned'
  | 'rider.assigned'
  | 'rider.arrived'
  | 'count.verified'
  | 'count.disputed'
  | 'overage.approved'
  | 'code.accepted'
  | 'bag.sealed'
  | 'facility.received'
  | 'facility.qa_passed'
  | 'facility.qa_failed'
  | 'logistics.qa_passed'
  | 'logistics.qa_failed'
  | 'order.delivered'
  | 'qa_window.opened'
  | 'qa_window.closed'
  | 'dispute.raised'
  | 'dispute.resolved'
  | 'escrow.released';

/** Append-only. Never updated, never deleted. */
export interface OrderEvent {
  readonly orderId: OrderId;
  readonly type: OrderEventType;
  readonly at: UtcTimestamp;
  readonly actor: 'customer' | 'partner' | 'rider' | 'admin' | 'system';
  readonly actorId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────
// Handoff codes
// ─────────────────────────────────────────────────────────────

export type HandoffCodeKind =
  /** Customer displays → rider enters. Proves the order belongs to this customer. */
  | 'identity'
  /** Customer displays → rider enters. Count agreed, bag sealed, count locked. */
  | 'release'
  /** Facility displays → rider enters. QA responsibility transfers to facility. */
  | 'facility'
  /** Customer displays → rider enters. Handover confirmed, QA window opens. */
  | 'delivery';

export interface HandoffCode {
  readonly orderId: OrderId;
  readonly kind: HandoffCodeKind;
  readonly expiresAt: UtcTimestamp;
  /** Which party is permitted to enter it. Enforced server-side. */
  readonly enteredBy: 'partner_logistics' | 'partner_facility';
  readonly attemptsRemaining: number;
  readonly consumedAt?: UtcTimestamp;
}

// ─────────────────────────────────────────────────────────────
// Partners
// ─────────────────────────────────────────────────────────────

export type PartnerCapability =
  | { readonly kind: 'facility'; readonly serviceId: ServiceId }
  | { readonly kind: 'logistics'; readonly vehicle: VehicleClass };

export interface Partner {
  readonly id: PartnerId;
  readonly displayName: string;
  readonly capabilities: readonly PartnerCapability[];
  readonly zoneIds: readonly ZoneId[];
  /** Rolling 30-day score. Warning below 85, suspension below 70. */
  readonly qaScore: number;
  readonly specialisations: readonly string[];
  readonly dailyCapacity: number;
  readonly capacityUsedToday: number;
  readonly kycStatus: 'pending' | 'approved' | 'suspended';
}

// ─────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────

export type LedgerAccount =
  | 'customer_receivable'
  | 'escrow_held'
  | 'partner_payable'
  | 'platform_commission'
  | 'platform_fees'
  | 'membership_benefit_cost'
  | 'refunds'
  | 'redo_deductions';

export type BenefitFundedBy = 'platform' | 'partner' | 'shared';

/**
 * Entries are created in balanced pairs and are immutable.
 * Debits and credits for a single posting must sum to zero.
 */
export interface LedgerEntry {
  readonly id: LedgerEntryId;
  readonly postingId: string;
  readonly account: LedgerAccount;
  readonly direction: 'debit' | 'credit';
  readonly amount: Money;
  readonly orderId?: OrderId;
  readonly partnerId?: PartnerId;
  readonly fundedBy?: BenefitFundedBy;
  readonly idempotencyKey: IdempotencyKey;
  readonly at: UtcTimestamp;
}

// ─────────────────────────────────────────────────────────────
// Entitlements
// ─────────────────────────────────────────────────────────────

export type MembershipTier = 'payg' | 'plus' | 'home' | 'business';

/**
 * A — costs real cash   (free delivery: the rider is still paid)
 * B — costs margin only (reduced service fee: revenue forgone, no cash out)
 * C — costs nothing     (priority dispatch, extended QA window)
 */
export type BenefitCostClass = 'A' | 'B' | 'C';

export interface Entitlement {
  readonly key: string;
  readonly tier: MembershipTier;
  readonly costClass: BenefitCostClass;
  readonly fundedBy: BenefitFundedBy;
  readonly appliesTo: readonly ServiceId[];
  /** Class A benefits must be capped. Enforced at resolution time. */
  readonly monthlyCap?: number;
  readonly minimumOrderValue?: Money;
}

// ─────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────

/**
 * Applied in this exact order, then floored. Changing the order changes
 * what customers pay — treat it as a money change requiring review.
 */
export interface PriceBreakdown {
  readonly itemsSubtotal: Money;
  readonly deliveryFee: Money;
  readonly speedSurcharge: Money;
  readonly commission: Money;
  readonly entitlementDiscount: Money;
  readonly promotionDiscount: Money;
  readonly total: Money;
  /** True if the margin floor clamped the result. Log and alert when set. */
  readonly floorApplied: boolean;
}
