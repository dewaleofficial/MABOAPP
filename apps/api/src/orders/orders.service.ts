/**
 * apps/api/src/orders/orders.service.ts
 *
 * CLAUDE.md §6 — every state transition goes through OrdersService. Nothing
 * writes order state directly. This class is the transactional boundary
 * between the pure, already-tested state machine in @provia/core and the
 * real database.
 *
 * The pattern per transition:
 *   1. BEGIN
 *   2. Read prior events for the order, in order
 *   3. Call attemptTransition() — pure, throws on any illegal move
 *   4. INSERT the returned event into order_events
 *   5. Recompute derived state, UPDATE orders.milestone_index (cache only)
 *   6. If this transition also moves money, delegate to LedgerService
 *      INSIDE THE SAME TRANSACTION — money and state change atomically
 *      together or not at all.
 *   7. COMMIT (or ROLLBACK on any failure, including a ledger imbalance)
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §6, §8, §18).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../common/pg.token';
import {
  attemptTransition,
  deriveState,
  getService,
  computePrice,
  IllegalTransitionError,
  MissingCodeError,
  type TransitionInput,
} from '@provia/core';
import type { HandoffCodeKind, OrderComposition, OrderEvent, OrderEventType, ServiceId } from '@provia/types';
import { LedgerService, type LedgerLine } from '../ledger/ledger.service';
import { HandoffCodesService, CodeMismatchError, CodeLockedOutError, NoActiveCodeError } from '../handoff-codes/handoff-codes.service';

export interface TransitionRequest {
  readonly orderId: string;
  readonly type: OrderEventType;
  readonly actor: OrderEvent['actor'];
  readonly actorId: string;
  readonly payload?: Record<string, unknown> | undefined;
  /** Ledger lines to post atomically with this transition, if any. */
  readonly ledgerLines?: readonly LedgerLine[];
}

export interface TransitionOutcome {
  readonly event: OrderEvent;
  readonly milestoneIndex: number;
  readonly milestoneKey: string;
  readonly isComplete: boolean;
  readonly postingId?: string | undefined;
}

export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`Order ${orderId} does not exist.`);
    this.name = 'OrderNotFoundError';
  }
}

export class BelowMinimumOrderError extends Error {
  constructor(
    public readonly serviceId: string,
    public readonly itemsSubtotal: number,
    public readonly minimumRequired: number,
  ) {
    super(
      `Order for "${serviceId}" totals ${String(itemsSubtotal)} kobo, below the ` +
        `${String(minimumRequired)} kobo minimum for this service.`,
    );
    this.name = 'BelowMinimumOrderError';
  }
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ledger: LedgerService,
    private readonly handoffCodes: HandoffCodesService,
  ) {}

  /**
   * Attempt to advance an order by one event. Fully atomic: the event
   * insert, the milestone_index cache update, and any ledger posting all
   * commit together or all roll back together.
   *
   * Throws IllegalTransitionError / MissingCodeError from the pure state
   * machine unchanged — callers (the HTTP controller) map these to 4xx
   * responses; this method does not swallow or reinterpret them.
   */
  async transition(request: TransitionRequest): Promise<TransitionOutcome> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');

      const orderRow = await db.query<{ service_id: ServiceId }>(
        `select service_id from public.orders where id = $1 for update`,
        [request.orderId],
      );
      if (orderRow.rows.length === 0) {
        throw new OrderNotFoundError(request.orderId);
      }
      const firstOrderRow = orderRow.rows[0];
      if (!firstOrderRow) throw new OrderNotFoundError(request.orderId); // unreachable given the length check above; kept for type-narrowing
      const serviceId = firstOrderRow.service_id;
      const service = getService(serviceId);

      const priorEventsResult = await db.query<{
        type: OrderEventType;
        actor: OrderEvent['actor'];
        actor_id: string;
        payload: Record<string, unknown>;
        at: string;
      }>(
        `select type, actor, actor_id, payload, at
           from public.order_events
          where order_id = $1
          order by at asc`,
        [request.orderId],
      );
      const priorEvents: OrderEvent[] = priorEventsResult.rows.map((r) => ({
        orderId: request.orderId as OrderEvent['orderId'],
        type: r.type,
        actor: r.actor,
        actorId: r.actor_id,
        payload: r.payload,
        at: r.at as OrderEvent['at'],
      }));

      // The dangerous line: this is the ONLY place the pure, already-tested
      // state machine gets called with real data. If this throws, we roll
      // back below and nothing was written — the order is exactly as it
      // was before this call was made.
      const input: TransitionInput = {
        orderId: request.orderId,
        type: request.type,
        actor: request.actor,
        actorId: request.actorId,
        payload: request.payload,
      };
      const newEvent = attemptTransition(service, priorEvents, input);

      const inserted = await db.query<{ id: string }>(
        `insert into public.order_events (order_id, type, actor, actor_id, payload, at)
         values ($1,$2,$3,$4,$5,$6)
         returning id`,
        [
          request.orderId,
          newEvent.type,
          newEvent.actor,
          newEvent.actorId,
          JSON.stringify(newEvent.payload),
          newEvent.at,
        ],
      );
      void inserted; // id not currently surfaced to the caller; kept for future audit linkage

      const derived = deriveState(service, [...priorEvents, newEvent]);

      await db.query(`update public.orders set milestone_index = $1, updated_at = now() where id = $2`, [
        derived.milestoneIndex,
        request.orderId,
      ]);

      // CLAUDE.md §11 — the code is generated in this SAME transaction as
      // the milestone event that requires it. If the newly-reached
      // milestone declares requiresCode, the order can never sit in that
      // state with no code to show — either both the event and the code
      // exist, or (on any failure below) neither does.
      const newMilestone = service.milestones[derived.milestoneIndex];
      if (newMilestone?.requiresCode) {
        const enteredBy =
          newMilestone.requiresCode === 'facility' ? 'partner_facility' : 'partner_logistics';
        await this.handoffCodes.generate(db, request.orderId, newMilestone.requiresCode, enteredBy);
      }

      let postingId: string | undefined;
      if (request.ledgerLines && request.ledgerLines.length > 0) {
        // Same transaction (`db` is passed through) — the ledger posting and
        // the event/milestone update are atomic together (CLAUDE.md §8).
        const result = await this.ledger.post(request.ledgerLines, db);
        postingId = result.postingId;
      }

      await db.query('COMMIT');

      return {
        event: newEvent,
        milestoneIndex: derived.milestoneIndex,
        milestoneKey: derived.milestoneKey,
        isComplete: derived.isComplete,
        postingId,
      };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  /**
   * Verify a handoff code and, on success, advance the order past the
   * milestone that required it — same outcome shape as transition().
   *
   * DELIBERATELY TWO SEPARATE TRANSACTIONS, not one — this is a reasoned
   * exception to the "everything atomic together" pattern used
   * everywhere else in this file, and it matters:
   *
   *   Phase 1 verifies the code in its OWN transaction. A WRONG guess
   *   decrements attempts_remaining and that decrement must durably
   *   persist even though nothing else happens — if verification were
   *   nested inside the same transaction as the eventual milestone
   *   advance, a caller who then aborted (or a wrong-code path that
   *   never reaches an advance at all) would roll the decrement back
   *   too, silently resetting the attack surface an attacker could keep
   *   retrying. The lockout in HandoffCodesService.verify() only works
   *   if wrong attempts are permanently recorded.
   *
   *   Phase 2 (only reached if phase 1's code was CORRECT) runs the
   *   normal transition() — the code.accepted event, the milestone
   *   advance, and any ledger posting, atomic together exactly as usual.
   */
  async transitionWithCode(request: {
    readonly orderId: string;
    readonly kind: HandoffCodeKind;
    readonly code: string;
    readonly actor: OrderEvent['actor'];
    readonly actorId: string;
  }): Promise<TransitionOutcome> {
    const verifyClient = await this.pool.connect();
    try {
      await verifyClient.query('BEGIN');
      // Row lock inside verify() serialises concurrent attempts; on a
      // wrong guess it ALSO writes the decremented attempts_remaining
      // before throwing — that write must be COMMITTED, not rolled back,
      // or the lockout mechanism silently does nothing (a bug caught by
      // this file's own test suite: see the "wrong code decrements" and
      // "3 attempts locks out" tests).
      await this.handoffCodes.verify(verifyClient, request.orderId, request.kind, request.code);
      await verifyClient.query('COMMIT');
    } catch (err) {
      if (
        err instanceof CodeMismatchError ||
        err instanceof CodeLockedOutError ||
        err instanceof NoActiveCodeError
      ) {
        // A known, expected business-logic outcome — verify() may have
        // already written a real state change (the decrement) that must
        // survive. Commit what happened, then propagate the error.
        await verifyClient.query('COMMIT');
        throw err;
      }
      // Anything else (a genuine DB/connection failure) really should be
      // rolled back — nothing about it is a legitimate outcome to keep.
      await verifyClient.query('ROLLBACK');
      throw err;
    } finally {
      verifyClient.release();
    }

    // Phase 2 — code was correct. Advance the order normally; this is
    // the exact same atomic path as any other transition.
    return this.transition({
      orderId: request.orderId,
      type: 'code.accepted',
      actor: request.actor,
      actorId: request.actorId,
      payload: { kind: request.kind },
    });
  }

  /**
   * Create a new order with a REAL, server-computed price.
   *
   * This is the fix for a real, previously-flagged gap: the pilot's
   * customer app was creating orders via a direct Supabase insert with
   * total_amount hardcoded to 0, because no order-creation endpoint
   * existed. That meant computePrice() — built, tested, and proven
   * yesterday — was never exercised by the pilot at all.
   *
   * CLAUDE.md §3.9 — the server never trusts a client-supplied price. The
   * request body carries only an OrderComposition (what the customer
   * wants to order); computePrice() derives the actual charge from it,
   * server-side, using the same commission rate and margin floor used
   * everywhere else. The client never sends, and this method never
   * reads, anything resembling a total.
   *
   * Pricing inputs (commission rate, entitlements, margin floor) are
   * hardcoded to sane pilot defaults here — commission 15%, no
   * entitlements, a small margin floor — because there is no
   * partner-commission-rate table or entitlement-redemption store built
   * yet. This is a real, intentional simplification for the pilot, not a
   * hidden shortcut: a full implementation resolves commission per
   * partner and entitlements per customer, neither of which exists as
   * real data yet.
   */
  async createOrder(request: {
    readonly customerId: string;
    readonly serviceId: ServiceId;
    readonly zoneId: string;
    readonly composition: OrderComposition;
  }): Promise<{ readonly orderId: string; readonly total: number; readonly currency: string }> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');

      const service = getService(request.serviceId);

      // The actual fix: price is computed HERE, server-side, from the
      // composition the client submitted — never trusted as a number the
      // client sent directly.
      const breakdown = computePrice(
        {
          service,
          composition: request.composition,
          commission: { ratePercent: 15 }, // pilot default — see method header
          entitlements: [], // pilot default — no entitlement store yet
          currency: 'NGN',
          minMargin: { amount: 50_000 as never, currency: 'NGN' }, // ₦500 floor
        },
        {
          serviceId: request.serviceId,
          orderValueSoFar: { amount: 0 as never, currency: 'NGN' },
          redemptionsThisMonth: () => 0,
        },
      );

      if (breakdown.belowMinimumOrder) {
        throw new BelowMinimumOrderError(request.serviceId, breakdown.itemsSubtotal.amount, service.minimumOrderValue.amount);
      }

      // ============================================================
      // PILOT-SCOPE AUTO-ASSIGNMENT — real, explicit, deliberately dumb.
      // ============================================================
      // Confirmed with the founder: "Yes for now, auto-assign. no
      // approved matching logic for now." This is NOT the real matching
      // engine described in CLAUDE.md §13 (QA score, specialisation,
      // capacity, fairness rotation) — that's real future work. This
      // assigns the ONE pilot partner to every order, unconditionally.
      //
      // PILOT_PARTNER_ID comes from an environment variable, not a
      // hardcoded literal like PILOT_ZONE_ID — the zone could be seeded
      // ahead of time (infra/seed/zones.sql), but the pilot partner's
      // real id doesn't exist until their actual Supabase user and
      // partners row are created, which happens as part of onboarding
      // them, not at build time.
      //
      // Laundry needs BOTH a facility leg and a logistics leg — the
      // single pilot partner fills both roles, matching CLAUDE.md §13's
      // note that one partner account can hold multiple capabilities.
      // Courier has no facility leg at all (CLAUDE.md §2's dropped
      // milestones 5–8), so only logistics_partner_id is set for it.
      const pilotPartnerId = process.env['PILOT_PARTNER_ID'];
      if (!pilotPartnerId) {
        throw new Error(
          'PILOT_PARTNER_ID is not set. This pilot-scope auto-assignment ' +
            'requires a real partner id — see the comment above this check.',
        );
      }
      const facilityPartnerId = request.serviceId === 'courier' ? null : pilotPartnerId;
      const logisticsPartnerId = pilotPartnerId;

      const inserted = await db.query<{ id: string }>(
        `insert into public.orders (service_id, customer_id, facility_partner_id, logistics_partner_id, zone_id, total_amount, currency, details)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          request.serviceId,
          request.customerId,
          facilityPartnerId,
          logisticsPartnerId,
          request.zoneId,
          breakdown.total.amount,
          breakdown.total.currency,
          JSON.stringify(request.composition),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Insert into orders returned no row — should be impossible.');

      await db.query('COMMIT');

      return { orderId: row.id, total: breakdown.total.amount, currency: breakdown.total.currency };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  /**
   * Read-only projection of an order's current state for the GET endpoint.
   * Derives milestone info fresh from order_events via the same pure
   * deriveState() used by transition() — never trusts the milestone_index
   * cache column alone, so a read is never wrong even if the cache write
   * in transition() were ever to fall behind (it shouldn't, since it's in
   * the same transaction, but a read path that re-derives is a cheap extra
   * guarantee, not a cost worth skipping).
   */
  async getOrderProjection(orderId: string): Promise<{
    readonly orderId: string;
    readonly serviceId: ServiceId;
    readonly milestoneIndex: number;
    readonly milestoneKey: string;
    readonly isComplete: boolean;
  } | null> {
    const orderRow = await this.pool.query<{ service_id: ServiceId }>(
      `select service_id from public.orders where id = $1`,
      [orderId],
    );
    const first = orderRow.rows[0];
    if (!first) return null;

    const service = getService(first.service_id);

    const eventsResult = await this.pool.query<{
      type: OrderEventType;
      actor: OrderEvent['actor'];
      actor_id: string;
      payload: Record<string, unknown>;
      at: string;
    }>(
      `select type, actor, actor_id, payload, at
         from public.order_events
        where order_id = $1
        order by at asc`,
      [orderId],
    );
    const events: OrderEvent[] = eventsResult.rows.map((r) => ({
      orderId: orderId as OrderEvent['orderId'],
      type: r.type,
      actor: r.actor,
      actorId: r.actor_id,
      payload: r.payload,
      at: r.at as OrderEvent['at'],
    }));

    const derived = deriveState(service, events);

    return {
      orderId,
      serviceId: first.service_id,
      milestoneIndex: derived.milestoneIndex,
      milestoneKey: derived.milestoneKey,
      isComplete: derived.isComplete,
    };
  }

  /**
   * Every order assigned to this partner, as either the facility or
   * logistics side — resolved from their auth_user_id (the JWT's
   * verified userId), never a client-supplied partner id. This is the
   * partner app's real order list. RLS on `orders` (0001_foundation.sql)
   * enforces the same scope at the database level as a second layer,
   * matching the defence-in-depth principle already documented on
   * getOrderProjection above.
   *
   * Each row's milestone info is re-derived fresh, same as
   * getOrderProjection — a list is not a shortcut that trusts the cache
   * column alone either.
   */
  async listForPartner(authUserId: string): Promise<
    readonly {
      readonly orderId: string;
      readonly serviceId: ServiceId;
      readonly milestoneIndex: number;
      readonly milestoneKey: string;
      readonly isComplete: boolean;
    }[]
  > {
    const partnerRow = await this.pool.query<{ id: string }>(
      `select id from public.partners where auth_user_id = $1`,
      [authUserId],
    );
    const partner = partnerRow.rows[0];
    if (!partner) return []; // not a partner account — nothing assigned, not an error

    const orderRows = await this.pool.query<{ id: string; service_id: ServiceId }>(
      `select id, service_id from public.orders
        where facility_partner_id = $1 or logistics_partner_id = $1
        order by created_at desc`,
      [partner.id],
    );

    const results = await Promise.all(
      orderRows.rows.map(async (row) => {
        const projection = await this.getOrderProjection(row.id);
        // getOrderProjection cannot return null here — we just selected
        // this id from orders directly — but the type is nullable for its
        // other (client-supplied-id) call site, so narrow explicitly
        // rather than asserting.
        if (!projection) throw new Error(`Order ${row.id} vanished between list and projection — should be impossible.`);
        return projection;
      }),
    );
    return results;
  }
}

// Re-exported so callers (e.g. the HTTP controller) can catch by type
// without importing directly from @provia/core.
export { IllegalTransitionError, MissingCodeError };
