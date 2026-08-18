/**
 * packages/core/src/engine/stateMachine.ts
 *
 * CLAUDE.md §6, §7, §10 — order state is DERIVED from order_events. There is
 * no setter on OrderState. The only way to change an order is to attempt an
 * event; this module decides whether that attempt is legal, and if so,
 * returns the event to append plus the resulting derived state.
 *
 * This module never touches the database. It is pure. The NestJS
 * OrdersService is the thing that calls this, persists the returned event
 * inside a transaction, and updates the orders.milestone_index cache column.
 * Keeping this pure is what makes it testable without Postgres and safe for
 * an agent to modify with confidence.
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §6, §8, §18).
 */

import type {
  OrderEvent,
  OrderEventType,
  OrderState,
  ServiceModule,
  MilestoneSpec,
  HandoffCodeKind,
  UtcTimestamp,
} from '@provia/types';
import { utc } from '@provia/types';

// ─────────────────────────────────────────────────────────────
// Errors — typed, not thrown strings (CLAUDE.md §6)
// ─────────────────────────────────────────────────────────────

export class IllegalTransitionError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly attempted: OrderEventType,
    public readonly atMilestone: string,
    public readonly reason: string,
  ) {
    super(
      `Illegal transition on order ${orderId}: cannot apply "${attempted}" ` +
        `at milestone "${atMilestone}" — ${reason}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export class MissingCodeError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly milestone: string,
    public readonly requiredCode: HandoffCodeKind,
  ) {
    super(
      `Order ${orderId} cannot advance past "${milestone}" without a verified ` +
        `"${requiredCode}" code (CLAUDE.md §11 — the three-code handshake).`,
    );
    this.name = 'MissingCodeError';
  }
}

// ─────────────────────────────────────────────────────────────
// The mapping from milestone → the event type that advances past it.
//
// This is spine-level plumbing, not service-specific — it is the same
// shape for every service, because MilestoneSpec.key is what varies, not
// the concept of "an event advances you past a milestone." A service module
// supplies its own milestones array; this map only needs to know, for a
// given milestone key, what event type is the one that completes it.
//
// CLAUDE.md §2 — never branch on service id here. This switches on event
// TYPE, which is spine vocabulary, not on service id.
// ─────────────────────────────────────────────────────────────

const ADVANCING_EVENT: Partial<Record<string, OrderEventType>> = {
  // ── laundry (packages/core/src/services/laundry.ts) ──
  placed: 'order.paid',
  rider_assigned: 'rider.assigned',
  rider_enroute: 'rider.arrived',
  rider_arrived: 'code.accepted', // identity code — see requiresCode on the milestone
  count_verified: 'bag.sealed', // release code — see requiresCode on the milestone
  bag_sealed: 'facility.received', // facility code — see requiresCode on the milestone
  facility_received: 'facility.qa_passed',
  facility_working: 'facility.qa_passed',
  facility_qa: 'logistics.qa_passed',
  logistics_qa: 'order.delivered',
  out_for_delivery: 'order.delivered', // delivery code — see requiresCode on the milestone
  delivered: 'qa_window.opened',
  qa_window: 'qa_window.closed',

  // ── courier (packages/core/src/services/courier.ts) ──
  // Distinct, courier_-prefixed keys — deliberately not sharing laundry's
  // keys above, even where a courier milestone is conceptually similar
  // (e.g. "rider arrives"), so there is no ambiguity about which service's
  // milestone a given lookup resolves to. Reusing the same OrderEventType
  // VALUE at two different keys (e.g. 'rider.arrived' below) is fine and
  // already established by laundry's own out_for_delivery/logistics_qa
  // pair above, which both resolve to 'order.delivered'.
  courier_placed: 'order.paid',
  courier_rider_assigned: 'rider.assigned',
  courier_at_pickup: 'rider.arrived',
  courier_collected: 'code.accepted', // identity code — sender's code, authorises handover
  courier_at_dropoff: 'rider.arrived',
  courier_delivered: 'order.delivered', // delivery code — recipient's code
  courier_qa_window: 'qa_window.opened',
  // courier_complete has no entry — reaching the last milestone IS
  // completion (see deriveState's isComplete, index >= length - 1).
};

/**
 * Read-only accessor for ADVANCING_EVENT — lets callers outside this module
 * (OrdersService.transitionWithCode) determine what event actually advances
 * a given milestone, without duplicating this map or reaching into
 * module-private state. Keyed purely by milestone key, same as the map
 * itself — no service parameter needed, since ADVANCING_EVENT is already
 * shared/flat across every service's milestone keys.
 */
export function getAdvancingEvent(milestoneKey: string): OrderEventType | undefined {
  return ADVANCING_EVENT[milestoneKey];
}

/** Events that can occur at (almost) any point and do not advance the milestone index. */
const SIDE_EVENTS: readonly OrderEventType[] = [
  'count.disputed',
  'overage.approved',
  'facility.qa_failed',
  'logistics.qa_failed',
  'dispute.raised',
  'dispute.resolved',
  'escrow.released',
];

// ─────────────────────────────────────────────────────────────
// Derive current state from the event log.
//
// This is the ONLY function allowed to compute "what milestone is this order
// at". Nothing else in the codebase should infer state from anything but
// this — not from the latest event's payload, not from a status column.
// ─────────────────────────────────────────────────────────────

export interface DerivedOrderState {
  readonly milestoneIndex: number;
  readonly milestoneKey: string;
  readonly isComplete: boolean;
  readonly isTerminal: boolean;
  /** Handoff code kinds satisfied so far, in event order. */
  readonly codesAccepted: readonly HandoffCodeKind[];
  readonly lastEventAt: UtcTimestamp | null;
}

export function deriveState(
  service: ServiceModule,
  events: readonly OrderEvent[],
): DerivedOrderState {
  const milestones = service.milestones;
  let index = 0;
  const codesAccepted: HandoffCodeKind[] = [];
  let lastEventAt: UtcTimestamp | null = null;

  // Events are assumed already ordered by `at` ascending — the caller reads
  // them from order_events with `order by at asc`, matching the index in the
  // migration (CLAUDE.md §7).
  for (const event of events) {
    lastEventAt = event.at;

    const currentMilestone = milestones[index];
    if (!currentMilestone) break; // already past the end

    const expected = ADVANCING_EVENT[currentMilestone.key];

    if (event.type === 'code.accepted') {
      const kind = event.payload['kind'];
      if (typeof kind === 'string') codesAccepted.push(kind as HandoffCodeKind);
    }

    if (expected && event.type === expected) {
      index += 1;
    }
    // Side events (disputes, QA failures, etc.) are recorded but never move
    // the index. A facility.qa_failed does not advance milestoneIndex — it
    // is read by the caller to decide whether to route back to processing.
  }

  const finalMilestone = milestones[Math.min(index, milestones.length - 1)];

  // Terminal means "reached the last milestone the service module itself
  // defines" — this must be judged purely from the service's own milestones
  // array length, not from whether the spine happens to have an
  // ADVANCING_EVENT mapping for that key. The service module is the source
  // of truth for how many steps its lifecycle has (CLAUDE.md §2); the spine
  // must not second-guess that by inspecting its own lookup table.
  const isComplete = index >= milestones.length - 1;

  return {
    milestoneIndex: index,
    milestoneKey: finalMilestone?.key ?? 'unknown',
    isComplete,
    isTerminal: isComplete,
    codesAccepted,
    lastEventAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Attempt a transition.
//
// Pure function: given the service, the events so far, and a proposed
// event, either returns the event ready to append (with server-assigned
// timestamp) or throws a typed error. The caller persists the returned
// event; this function never persists anything itself.
// ─────────────────────────────────────────────────────────────

export interface TransitionInput {
  readonly orderId: string;
  readonly type: OrderEventType;
  readonly actor: OrderEvent['actor'];
  readonly actorId: string;
  readonly payload?: Record<string, unknown> | undefined;
}

export function attemptTransition(
  service: ServiceModule,
  priorEvents: readonly OrderEvent[],
  input: TransitionInput,
): OrderEvent {
  const state = deriveState(service, priorEvents);
  const milestones = service.milestones;

  if (state.isTerminal && !SIDE_EVENTS.includes(input.type)) {
    throw new IllegalTransitionError(
      input.orderId,
      input.type,
      state.milestoneKey,
      'order is already complete',
    );
  }

  const currentMilestone: MilestoneSpec | undefined = milestones[state.milestoneIndex];
  if (!currentMilestone) {
    throw new IllegalTransitionError(input.orderId, input.type, state.milestoneKey, 'no such milestone');
  }

  // Side events are always legal (a dispute can be raised at any live
  // milestone) — record and return without further checks.
  if (SIDE_EVENTS.includes(input.type)) {
    return {
      orderId: input.orderId as OrderEvent['orderId'],
      type: input.type,
      actor: input.actor,
      actorId: input.actorId,
      payload: input.payload ?? {},
      at: utc(new Date()),
    };
  }

  const expected = ADVANCING_EVENT[currentMilestone.key];

  // A code.accepted event matching THIS milestone's own requiresCode kind
  // is always legal to record, even when it isn't the milestone's own
  // advancing event (e.g. bag_sealed's requiresCode is 'release' but its
  // advancing event is 'facility.received') — it satisfies a LATER attempt
  // at the real advancing event's requiresCode gate below. It never
  // advances the milestone by itself: deriveState only increments index on
  // event.type === expected, and this event's type is 'code.accepted',
  // which only equals expected at milestones where they're the same thing
  // (e.g. rider_arrived).
  const isCodeRecordingForThisMilestone =
    input.type === 'code.accepted' &&
    currentMilestone.requiresCode !== undefined &&
    input.payload?.['kind'] === currentMilestone.requiresCode;

  if (input.type !== expected && !isCodeRecordingForThisMilestone) {
    throw new IllegalTransitionError(
      input.orderId,
      input.type,
      currentMilestone.key,
      `expected "${expected ?? '(no advancing event defined)'}" to advance past this milestone`,
    );
  }

  // CLAUDE.md §11 — a milestone that requires a code cannot be passed
  // without that code having been accepted first. This is enforced here,
  // in the spine, not left to each caller to remember.
  if (currentMilestone.requiresCode && input.type !== 'code.accepted') {
    const alreadyHasCode = state.codesAccepted.includes(currentMilestone.requiresCode);
    if (!alreadyHasCode) {
      throw new MissingCodeError(input.orderId, currentMilestone.key, currentMilestone.requiresCode);
    }
  }

  return {
    orderId: input.orderId as OrderEvent['orderId'],
    type: input.type,
    actor: input.actor,
    actorId: input.actorId,
    payload: input.payload ?? {},
    at: utc(new Date()),
  };
}

// ─────────────────────────────────────────────────────────────
// Convenience: build the customer-facing OrderState projection.
// This is what the API returns to the client — never the raw event array.
// ─────────────────────────────────────────────────────────────

export function projectOrderState(
  base: Omit<OrderState, 'milestoneIndex'>,
  service: ServiceModule,
  events: readonly OrderEvent[],
): OrderState {
  const derived = deriveState(service, events);
  return { ...base, milestoneIndex: derived.milestoneIndex };
}
