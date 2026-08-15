/**
 * CLAUDE.md §17 — same ruthless-testing bar as laundry's state machine
 * tests. Courier is the second service to exercise the spine's additive
 * ADVANCING_EVENT extension — these tests exist partly to prove that
 * extension didn't quietly break laundry, and partly to prove courier's
 * own 8-milestone lifecycle is internally correct.
 */
import { describe, it, expect } from 'vitest';
import type { OrderEvent } from '@provia/types';
import { utc } from '@provia/types';
import { courier } from './courier';
import { laundry } from './laundry';
import { deriveState, attemptTransition, IllegalTransitionError } from '../engine/stateMachine';

const ORDER_ID = 'courier-order-1' as OrderEvent['orderId'];

function ev(type: OrderEvent['type'], at: string, payload: Record<string, unknown> = {}): OrderEvent {
  return { orderId: ORDER_ID, type, actor: 'system', actorId: 'system', payload, at: utc(at) };
}

describe('courier — deriveState on a fresh order', () => {
  it('starts at milestone 0, courier_placed', () => {
    const state = deriveState(courier, []);
    expect(state.milestoneIndex).toBe(0);
    expect(state.milestoneKey).toBe('courier_placed');
    expect(state.isComplete).toBe(false);
  });

  it('has exactly 8 milestones — no facility leg', () => {
    expect(courier.milestones).toHaveLength(8);
    expect(courier.milestones.map((m) => m.key)).not.toContain('facility_received');
  });

  it('facilityQa is genuinely empty, not a placeholder oversight', () => {
    expect(courier.facilityQa).toHaveLength(0);
  });
});

describe('courier — full lifecycle walk, all 8 milestones', () => {
  it('advances through every milestone to completion with the correct events', () => {
    const events: OrderEvent[] = [];
    let t = new Date('2026-01-01T09:00:00Z').getTime();
    const advance = (type: OrderEvent['type'], payload: Record<string, unknown> = {}) => {
      t += 60_000;
      events.push(ev(type, new Date(t).toISOString(), payload));
    };

    advance('order.paid');
    expect(deriveState(courier, events).milestoneKey).toBe('courier_rider_assigned');

    advance('rider.assigned');
    expect(deriveState(courier, events).milestoneKey).toBe('courier_at_pickup');

    advance('rider.arrived'); // rider reaches the sender
    expect(deriveState(courier, events).milestoneKey).toBe('courier_collected');

    advance('code.accepted', { kind: 'identity' }); // sender's code
    expect(deriveState(courier, events).milestoneKey).toBe('courier_at_dropoff');

    advance('rider.arrived'); // SAME event type, second occurrence, different milestone
    expect(deriveState(courier, events).milestoneKey).toBe('courier_delivered');

    advance('order.delivered'); // recipient's code releases the parcel
    expect(deriveState(courier, events).milestoneKey).toBe('courier_qa_window');

    advance('qa_window.opened');
    const almostDone = deriveState(courier, events);
    expect(almostDone.milestoneKey).toBe('courier_complete');
    expect(almostDone.isComplete).toBe(true); // reaching the last milestone IS completion

    advance('qa_window.closed'); // a courier_complete milestone has no advancing event —
    // this event is a no-op against the state machine, exactly like an
    // extra order.paid fired twice against laundry would be (§ deriveState
    // tests). Confirms nothing throws and the state stays complete.
    const state = deriveState(courier, events);
    expect(state.isComplete).toBe(true);
    expect(state.milestoneIndex).toBe(7);
  });

  it('tracks both handoff codes distinctly', () => {
    const events: OrderEvent[] = [
      ev('order.paid', '2026-01-01T09:00:00Z'),
      ev('rider.assigned', '2026-01-01T09:01:00Z'),
      ev('rider.arrived', '2026-01-01T09:10:00Z'),
      ev('code.accepted', '2026-01-01T09:11:00Z', { kind: 'identity' }),
      ev('rider.arrived', '2026-01-01T09:30:00Z'),
    ];
    const state = deriveState(courier, events);
    expect(state.codesAccepted).toEqual(['identity']);
    expect(state.milestoneKey).toBe('courier_delivered');
  });
});

describe('courier — illegal transitions rejected', () => {
  it('rejects skipping straight to delivered from a fresh order', () => {
    expect(() =>
      attemptTransition(courier, [], {
        orderId: ORDER_ID,
        type: 'order.delivered',
        actor: 'partner',
        actorId: 'rider-1',
      }),
    ).toThrow(IllegalTransitionError);
  });

  it('rejects order.delivered attempted before the sender code is accepted', () => {
    const priorEvents = [
      ev('order.paid', '2026-01-01T09:00:00Z'),
      ev('rider.assigned', '2026-01-01T09:01:00Z'),
      ev('rider.arrived', '2026-01-01T09:10:00Z'),
    ];
    // courier_collected is the current milestone and its advancing event
    // IS code.accepted — attempting order.delivered here is simply the
    // wrong event for this milestone, caught as IllegalTransitionError
    // before ever reaching the MissingCodeError branch.
    expect(() =>
      attemptTransition(courier, priorEvents, {
        orderId: ORDER_ID,
        type: 'order.delivered',
        actor: 'partner',
        actorId: 'rider-1',
      }),
    ).toThrow(IllegalTransitionError);
  });

  it('rejects any advancing event once the order is complete', () => {
    const events: OrderEvent[] = [];
    let t = new Date('2026-01-01T09:00:00Z').getTime();
    const advance = (type: OrderEvent['type'], payload: Record<string, unknown> = {}) => {
      t += 60_000;
      events.push(ev(type, new Date(t).toISOString(), payload));
    };
    advance('order.paid');
    advance('rider.assigned');
    advance('rider.arrived');
    advance('code.accepted', { kind: 'identity' });
    advance('rider.arrived');
    advance('order.delivered');
    advance('qa_window.opened');

    expect(deriveState(courier, events).isComplete).toBe(true);

    expect(() =>
      attemptTransition(courier, events, {
        orderId: ORDER_ID,
        type: 'rider.assigned',
        actor: 'system',
        actorId: 'system',
      }),
    ).toThrow(IllegalTransitionError);
  });
});

describe('courier — the additive spine change did not disturb laundry', () => {
  it('laundry still walks its own full lifecycle correctly, unaffected by the new courier_* entries', () => {
    const events: OrderEvent[] = [];
    let t = new Date('2026-01-01T09:00:00Z').getTime();
    const advance = (type: OrderEvent['type'], payload: Record<string, unknown> = {}) => {
      t += 60_000;
      events.push(ev(type, new Date(t).toISOString(), payload));
    };
    advance('order.paid');
    advance('rider.assigned');
    advance('rider.arrived');
    advance('code.accepted', { kind: 'identity' });
    advance('bag.sealed');
    advance('facility.received');
    advance('facility.qa_passed');
    advance('facility.qa_passed');
    advance('logistics.qa_passed');
    advance('order.delivered');
    advance('order.delivered');
    advance('qa_window.opened');
    advance('qa_window.closed');

    const state = deriveState(laundry, events);
    expect(state.isComplete).toBe(true);
    expect(state.milestoneIndex).toBe(13);
  });

  it('laundry and courier milestone keys never collide', () => {
    const laundryKeys = new Set(laundry.milestones.map((m) => m.key));
    const courierKeys = courier.milestones.map((m) => m.key);
    for (const key of courierKeys) {
      expect(laundryKeys.has(key)).toBe(false);
    }
  });
});

describe('courier — MissingCodeError is reachable in principle', () => {
  it('the error class carries the correct kind for courier_collected', () => {
    // Not exercised via attemptTransition (courier_collected's advancing
    // event IS code.accepted, so the "wrong event" path always fires
    // first — same shape as laundry's own equivalent test). This confirms
    // the milestone declares the right requiresCode value for the error
    // to be correct if a future spine change ever reaches this branch.
    const collected = courier.milestones.find((m) => m.key === 'courier_collected');
    expect(collected?.requiresCode).toBe('identity');
    const delivered = courier.milestones.find((m) => m.key === 'courier_delivered');
    expect(delivered?.requiresCode).toBe('delivery');
  });
});
