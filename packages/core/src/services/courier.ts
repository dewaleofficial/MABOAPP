/**
 * packages/core/src/services/courier.ts
 *
 * The second service module, and the one CLAUDE.md §2 predicts should be
 * cheap: courier is laundry minus the facility leg entirely. No
 * transformation happens to the goods — a parcel goes from sender to
 * recipient, verified at both ends. Two handoff codes, not three or four.
 *
 * This file follows laundry.ts's shape exactly. If you're reading this to
 * understand the pattern for service #3, start with laundry.ts's own
 * header comment first — this one only documents what's genuinely
 * different, not the whole pattern again.
 */

import type {
  ServiceModule,
  ItemCategory,
  MilestoneSpec,
  QaCheck,
  EvidenceSpec,
  OrderComposition,
  VehicleClass,
  Money,
} from '@provia/types';
import { money, scale, sum } from '../money';

const NGN = 'NGN' as const;
const ngn = (kobo: number): Money => money(kobo, NGN);

// ─────────────────────────────────────────────────────────────
// Item model — a courier order moves parcels, not clothes. One category,
// size tiers as the items within it. No treatment/quality dimension exists
// for a parcel (CLAUDE.md §2 — categories differ per service; laundry's
// treatment/quality concept simply does not apply here and is not forced
// to exist just for structural symmetry).
// ─────────────────────────────────────────────────────────────

const categories: readonly ItemCategory[] = [
  {
    key: 'parcel', label: 'Parcel', emoji: '📦',
    items: [
      { key: 'documents',    label: 'Documents',       emoji: '📄', unitPrice: ngn(150_000) },
      { key: 'small',        label: 'Small parcel',    emoji: '📦', unitPrice: ngn(250_000) },
      { key: 'medium',       label: 'Medium parcel',   emoji: '📦', unitPrice: ngn(450_000) },
      { key: 'large_bulky',  label: 'Large / bulky',   emoji: '🛋️', unitPrice: ngn(900_000) },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// Milestones — 8 steps, not laundry's 14. No facility leg at all: the
// spine's shared ADVANCING_EVENT table (packages/core/src/engine/
// stateMachine.ts) gets 7 new, courier-prefixed entries alongside
// laundry's existing ones. Nothing in laundry's map is touched or
// reinterpreted — these are additive, distinctly-keyed entries, exactly
// what CLAUDE.md §2 means by "the spine's dispatch table grows."
//
// Two handoff codes only: 'identity' at collection (proves this is the
// sender, authorises handover to the rider) and 'delivery' at the
// recipient's door (opens the 24-hour QA window). There is no 'release'
// code — laundry's release code exists to lock an item count before a
// facility takes QA responsibility; courier has no facility to hand
// responsibility to, so collection and release collapse into one step.
// ─────────────────────────────────────────────────────────────

const milestones: readonly MilestoneSpec[] = [
  { key: 'courier_placed',         label: 'Order placed',                actor: 'system' },
  { key: 'courier_rider_assigned', label: 'Rider assigned',              actor: 'system' },
  { key: 'courier_at_pickup',      label: 'Rider at sender',             actor: 'partner_logistics' },
  { key: 'courier_collected',      label: 'Parcel collected',            actor: 'partner_logistics', requiresCode: 'identity', evidenceCount: 2 },
  { key: 'courier_at_dropoff',     label: 'Rider at recipient',          actor: 'partner_logistics' },
  { key: 'courier_delivered',      label: 'Delivered',                   actor: 'partner_logistics', requiresCode: 'delivery', evidenceCount: 1 },
  { key: 'courier_qa_window',      label: '24-hour window open',         actor: 'customer' },
  { key: 'courier_complete',       label: 'Complete',                    actor: 'system' },
];

// ─────────────────────────────────────────────────────────────
// QA — logistics only. facilityQa is a required field on ServiceModule
// but is correctly an empty array here: courier has no facility partner
// and therefore no facility-side check to run. This is not a placeholder
// to fill in later — it is the complete, correct answer for this service.
// ─────────────────────────────────────────────────────────────

const facilityQa: readonly QaCheck[] = [];

const logisticsQa: readonly QaCheck[] = [
  { key: 'condition',     label: 'Condition matches collection photos',   hint: 'No new damage since pickup' },
  { key: 'label_intact',  label: 'Label and address intact',              hint: 'Recipient details still legible' },
  { key: 'packaging',     label: 'Packaging secure',                      hint: 'Nothing loose, torn or open' },
  { key: 'complete',      label: 'Contents complete',                     hint: 'Nothing left behind at pickup' },
  { key: 'photos',        label: 'Delivery photo taken',                  hint: 'Proof of delivery on file' },
];

const evidence: readonly EvidenceSpec[] = [
  { atMilestone: 'courier_collected', minPhotos: 2, requireGpsWithinMetres: 50, maxAgeSeconds: 600 },
  { atMilestone: 'courier_delivered', minPhotos: 1, requireGpsWithinMetres: 50, maxAgeSeconds: 600 },
];

// ─────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────

const lookupUnitPrice = (itemKey: string): Money => {
  const item = categories[0]?.items.find((i) => i.key === itemKey);
  if (!item) throw new Error(`Unknown courier parcel tier: ${itemKey}`);
  return item.unitPrice;
};

const totalParcelCount = (order: OrderComposition): number =>
  order.groups.reduce(
    (n, g) => n + Object.values(g.items).reduce((a, b) => a + b, 0),
    0,
  );

/**
 * Documents and small parcels ride the bike — unless there are enough of
 * them that they no longer fit, matching laundry's own count threshold
 * (CLAUDE.md's vehicleRule pattern: category AND volume both matter, not
 * category alone). A single "small parcel" ×15 is not bike-sized in
 * practice even though no individual item is.
 */
const vehicleRule = (order: OrderComposition): VehicleClass =>
  order.groups.some((g) => Object.keys(g.items).some((k) => k === 'large_bulky' || k === 'medium')) ||
  totalParcelCount(order) > 10
    ? 'ev_van'
    : 'ev_bike';

/**
 * No treatment/quality multiplier — a parcel's price is purely its size
 * tier times quantity. Unlike laundry's priceItems, there is nothing to
 * compose-then-scale here (see CLAUDE.md's note on money.ts rounding),
 * because there is only one multiplier-free line per parcel type.
 */
const priceItems = (order: OrderComposition): Money =>
  sum(
    order.groups.map((g) =>
      sum(
        Object.entries(g.items).map(([itemKey, qty]) => scale(lookupUnitPrice(itemKey), qty)),
        NGN,
      ),
    ),
    NGN,
  );

// ─────────────────────────────────────────────────────────────

export const courier: ServiceModule = {
  id: 'courier',
  label: 'Courier',
  categories,
  milestones,
  facilityQa,
  logisticsQa,
  capacityUnit: 'orders_per_day',
  evidence,
  /** The cheapest real tier (documents) must clear the floor on its own —
   *  courier has no per-item minimum the way laundry's 3-item norm does. */
  minimumOrderValue: ngn(150_000),
  vehicleRule,
  priceItems,
};
