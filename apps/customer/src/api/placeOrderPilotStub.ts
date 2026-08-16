/**
 * src/api/placeOrderPilotStub.ts
 *
 * This used to insert directly into `orders` via the Supabase client with
 * total_amount hardcoded to 0, because no order-creation endpoint existed
 * (see git history for the old header, which documented that gap in
 * full). apps/api/src/orders/orders.controller.ts now exposes a real
 * POST /orders, so this function's only job is to shape each screen's
 * draft data into an OrderComposition and call createOrder() — it never
 * computes or sends a price; computePrice() derives the real total
 * server-side from the composition (CLAUDE.md §3.9), and customerId comes
 * from the verified JWT, never from this file.
 *
 * One pilot-scope simplification remains, deliberate and flagged rather
 * than hidden: speed is hardcoded to 'standard' because neither builder
 * screen has a speed-tier selector yet.
 */

import { createOrder } from './client';
import type { LaundryGroupDraft } from '../navigation/types';
import type { OrderComposition, OrderGroup, ServiceId, ZoneId } from '@provia/types';

/**
 * The zone used by every pilot order. Must match the fixed id seeded by
 * infra/seed/zones.sql ("Ikeja Test Zone") exactly — that file's insert
 * uses this same literal UUID rather than gen_random_uuid() specifically
 * so this constant can reference it directly. If zones.sql's id ever
 * changes, update this constant in the same change, or order creation
 * fails with a foreign key violation against orders.zone_id.
 *
 * A real client would resolve the customer's zone from their saved
 * address; that resolution doesn't exist yet and shouldn't be invented
 * client-side.
 */
const PILOT_ZONE_ID = '11111111-1111-1111-1111-111111111111' as ZoneId;

export interface PlaceOrderResult {
  readonly orderId: string;
}

export interface PlaceOrderDetails {
  readonly groups?: readonly LaundryGroupDraft[];
  readonly parcels?: Record<string, number>;
  readonly pickupAddress?: string;
  readonly dropoffAddress?: string;
}

/**
 * Courier has no treatment/quality dimension (packages/core/src/services/
 * courier.ts's priceItems never reads these fields) — they're still
 * required by OrderGroup because the composition shape is shared across
 * every service on the spine, not because courier uses them.
 */
function buildComposition(serviceId: ServiceId, details: PlaceOrderDetails): OrderComposition {
  const groups: readonly OrderGroup[] =
    serviceId === 'courier'
      ? [
          {
            categoryKey: 'parcel',
            items: details.parcels ?? {},
            treatmentKey: '',
            qualityKey: '',
            careFlags: [],
            note: `${details.pickupAddress ?? ''} → ${details.dropoffAddress ?? ''}`,
          },
        ]
      : (details.groups ?? []).map((g) => ({
          categoryKey: g.categoryKey,
          items: g.items,
          treatmentKey: g.treatmentKey,
          qualityKey: g.qualityKey,
          careFlags: [],
          note: '',
        }));

  return { serviceId, groups, speed: 'standard', zoneId: PILOT_ZONE_ID };
}

export async function placeOrderPilotStub(
  serviceId: ServiceId,
  details: PlaceOrderDetails,
): Promise<PlaceOrderResult> {
  const composition = buildComposition(serviceId, details);
  const result = await createOrder(serviceId, PILOT_ZONE_ID, composition);
  return { orderId: result.orderId };
}
