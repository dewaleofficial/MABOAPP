/**
 * packages/core/services/laundry.ts
 *
 * The reference service module. Every other service is built by copying this
 * shape and changing the data — not by adding branches to the spine.
 *
 * If you need behaviour that cannot be expressed in this interface, that
 * behaviour belongs in the spine. Say so before writing it.
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
// Item model — covers everyone, not just menswear
// ─────────────────────────────────────────────────────────────

const categories: readonly ItemCategory[] = [
  {
    key: 'men', label: 'Men', emoji: '👔',
    items: [
      { key: 'shirt',   label: 'Shirt',   emoji: '👔', unitPrice: ngn(40_000) },
      { key: 'trouser', label: 'Trouser', emoji: '👖', unitPrice: ngn(45_000) },
      { key: 'blazer',  label: 'Blazer',  emoji: '🧥', unitPrice: ngn(80_000) },
      { key: 'kaftan',  label: 'Kaftan',  emoji: '🥻', unitPrice: ngn(70_000) },
      { key: 'agbada',  label: 'Agbada',  emoji: '👘', unitPrice: ngn(150_000) },
    ],
  },
  {
    key: 'women', label: 'Women', emoji: '👗',
    items: [
      { key: 'blouse',     label: 'Blouse',      emoji: '👚', unitPrice: ngn(40_000) },
      { key: 'dress',      label: 'Dress',       emoji: '👗', unitPrice: ngn(70_000) },
      { key: 'skirt',      label: 'Skirt',       emoji: '🩱', unitPrice: ngn(45_000) },
      { key: 'iro_buba',   label: 'Iro & Buba',  emoji: '👘', unitPrice: ngn(140_000) },
      { key: 'gele',       label: 'Gele',        emoji: '🧣', unitPrice: ngn(50_000) },
    ],
  },
  {
    key: 'children', label: 'Children', emoji: '🧒',
    items: [
      { key: 'kids_top',    label: 'Kids top',       emoji: '👕', unitPrice: ngn(25_000) },
      { key: 'kids_shorts', label: 'Kids shorts',    emoji: '🩳', unitPrice: ngn(25_000) },
      { key: 'kids_dress',  label: 'Kids dress',     emoji: '👗', unitPrice: ngn(35_000) },
      { key: 'uniform',     label: 'School uniform', emoji: '🎒', unitPrice: ngn(40_000) },
    ],
  },
  {
    key: 'corporate', label: 'Corporate', emoji: '💼',
    items: [
      { key: 'suit_2pc',  label: '2-piece suit', emoji: '🤵', unitPrice: ngn(180_000) },
      { key: 'waistcoat', label: 'Waistcoat',    emoji: '🎽', unitPrice: ngn(60_000) },
      { key: 'tie',       label: 'Tie',          emoji: '👔', unitPrice: ngn(25_000) },
      { key: 'overcoat',  label: 'Overcoat',     emoji: '🧥', unitPrice: ngn(160_000) },
    ],
  },
  {
    key: 'bedding', label: 'Bedding', emoji: '🛏️',
    items: [
      { key: 'bed_sheet',  label: 'Bed sheet',  emoji: '🛏️', unitPrice: ngn(70_000) },
      { key: 'duvet',      label: 'Duvet',      emoji: '🛌', unitPrice: ngn(180_000) },
      { key: 'pillowcase', label: 'Pillowcase', emoji: '🧸', unitPrice: ngn(25_000) },
      { key: 'curtain',    label: 'Curtain',    emoji: '🪟', unitPrice: ngn(120_000) },
    ],
  },
  {
    key: 'delicates', label: 'Delicates', emoji: '🥻',
    items: [
      { key: 'silk',   label: 'Silk item',     emoji: '🥻', unitPrice: ngn(100_000) },
      { key: 'lace',   label: 'Lace outfit',   emoji: '🕸️', unitPrice: ngn(160_000) },
      { key: 'beaded', label: 'Beaded outfit', emoji: '💎', unitPrice: ngn(220_000) },
      { key: 'wool',   label: 'Wool knit',     emoji: '🧶', unitPrice: ngn(90_000) },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// Pricing multipliers
// ─────────────────────────────────────────────────────────────

const TREATMENTS: Record<string, number> = {
  wash_only:              1.00,
  wash_iron:              1.15,
  wash_starch_iron:       1.25,
  starch_iron:            1.10,
  dry_clean:              1.80,
  iron_only:              1.05,
};

const QUALITY: Record<string, number> = {
  regular:  1.00,
  standard: 1.20,
  premium:  1.50,
};

// ─────────────────────────────────────────────────────────────
// Milestones — the longest chain of any service.
// Courier drops facility_* and logistics_qa. Cleaning drops all logistics.
// ─────────────────────────────────────────────────────────────

const milestones: readonly MilestoneSpec[] = [
  { key: 'placed',            label: 'Order placed',                    actor: 'system' },
  { key: 'rider_assigned',    label: 'Rider assigned',                  actor: 'system' },
  { key: 'rider_enroute',     label: 'Rider on the way',                actor: 'partner_logistics' },
  { key: 'rider_arrived',     label: 'Rider at customer',               actor: 'partner_logistics', requiresCode: 'identity' },
  { key: 'count_verified',    label: 'Count verified',                  actor: 'partner_logistics', evidenceCount: 3 },
  { key: 'bag_sealed',        label: 'Bag sealed',                      actor: 'partner_logistics', requiresCode: 'release' },
  { key: 'facility_received', label: 'Delivered to partner',            actor: 'partner_facility',  requiresCode: 'facility' },
  { key: 'facility_working',  label: 'Being cleaned',                   actor: 'partner_facility' },
  { key: 'facility_qa',       label: 'Partner checks passed',           actor: 'partner_facility',  evidenceCount: 3 },
  { key: 'logistics_qa',      label: 'Rider verified and collected',    actor: 'partner_logistics' },
  { key: 'out_for_delivery',  label: 'On the way back',                 actor: 'partner_logistics' },
  { key: 'delivered',         label: 'Delivered',                       actor: 'partner_logistics', requiresCode: 'delivery' },
  { key: 'qa_window',         label: '24-hour window open',             actor: 'customer' },
  { key: 'complete',          label: 'Complete',                        actor: 'system' },
];

// ─────────────────────────────────────────────────────────────
// QA — three layers, two of them defined here
// ─────────────────────────────────────────────────────────────

const facilityQa: readonly QaCheck[] = [
  { key: 'count',      label: 'Item count correct',        hint: 'Matches the rider manifest exactly' },
  { key: 'stains',     label: 'Stains treated',            hint: 'Any flagged stain fully removed' },
  { key: 'smell',      label: 'Smell test',                hint: 'No mildew, no chemical odour' },
  { key: 'damage',     label: 'No new damage',             hint: 'No tears, missing buttons or colour run' },
  { key: 'press',      label: 'Press and fold quality',    hint: 'Crease-free, neatly folded' },
  { key: 'care',       label: 'Care instructions followed', hint: 'Every instruction on the order respected' },
  { key: 'packaging',  label: 'Packaging ready',           hint: 'Provia bag clean and undamaged' },
];

const logisticsQa: readonly QaCheck[] = [
  { key: 'count_match', label: 'Count matches manifest',   hint: 'What you dropped is what you are collecting' },
  { key: 'seal',        label: 'Partner seal intact',      hint: 'Provia sticker unbroken' },
  { key: 'damage',      label: 'No visible damage',        hint: 'Tears, buttons, colour run' },
  { key: 'smell_press', label: 'Smell and press quality',  hint: 'Clean, no odour, properly pressed' },
  { key: 'photos',      label: 'Partner photos uploaded',  hint: 'Completion photos on file' },
];

const evidence: readonly EvidenceSpec[] = [
  { atMilestone: 'count_verified', minPhotos: 3, requireGpsWithinMetres: 50, maxAgeSeconds: 600 },
  { atMilestone: 'facility_qa',    minPhotos: 3, requireGpsWithinMetres: 50, maxAgeSeconds: 600 },
  { atMilestone: 'delivered',      minPhotos: 2, requireGpsWithinMetres: 50, maxAgeSeconds: 600 },
];

// ─────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────

const lookupUnitPrice = (categoryKey: string, itemKey: string): Money => {
  const cat = categories.find((c) => c.key === categoryKey);
  const item = cat?.items.find((i) => i.key === itemKey);
  if (!item) throw new Error(`Unknown laundry item: ${categoryKey}/${itemKey}`);
  return item.unitPrice;
};

const totalItemCount = (order: OrderComposition): number =>
  order.groups.reduce(
    (n, g) => n + Object.values(g.items).reduce((a, b) => a + b, 0),
    0,
  );

/**
 * Bedding or a large load needs a van. Compose multipliers once and scale once
 * — see the warning on scale() about rounding drift.
 */
const vehicleRule = (order: OrderComposition): VehicleClass =>
  order.groups.some((g) => g.categoryKey === 'bedding') || totalItemCount(order) > 10
    ? 'ev_van'
    : 'ev_bike';

const priceItems = (order: OrderComposition): Money =>
  sum(
    order.groups.map((g) => {
      const base = sum(
        Object.entries(g.items).map(([itemKey, qty]) => {
          const unit = lookupUnitPrice(g.categoryKey, itemKey);
          return { amount: (unit.amount * qty) as typeof unit.amount, currency: NGN };
        }),
        NGN,
      );
      const treatment = TREATMENTS[g.treatmentKey];
      const quality = QUALITY[g.qualityKey];
      if (treatment === undefined) throw new Error(`Unknown treatment: ${g.treatmentKey}`);
      if (quality === undefined) throw new Error(`Unknown quality: ${g.qualityKey}`);
      // Compose multipliers, then round once.
      return scale(base, treatment * quality);
    }),
    NGN,
  );

// ─────────────────────────────────────────────────────────────

export const laundry: ServiceModule = {
  id: 'laundry',
  label: 'Laundry',
  categories,
  milestones,
  facilityQa,
  logisticsQa,
  capacityUnit: 'orders_per_day',
  evidence,
  /** Protects unit economics — delivery and QA cost the same on a small order. */
  minimumOrderValue: ngn(300_000),
  vehicleRule,
  priceItems,
};
