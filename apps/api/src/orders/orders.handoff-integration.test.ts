/**
 * apps/api/src/orders/orders.handoff-integration.test.ts
 *
 * The real end-to-end proof: an order genuinely reaches a code-requiring
 * milestone, a code genuinely exists for it, wrong guesses genuinely
 * decrement and lock out, and the correct code genuinely advances the
 * order — all against real Postgres, through OrdersService exactly as
 * the controller calls it, not through HandoffCodesService in isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { OrdersService, IllegalTransitionError } from './orders.service';
import { LedgerService } from '../ledger/ledger.service';
import { HandoffCodesService, CodeLockedOutError, CodeMismatchError } from '../handoff-codes/handoff-codes.service';

/**
 * Test-only helper: extract the first row of a query result without a
 * non-null assertion. Throws a clear, specific error if the query
 * unexpectedly returned nothing — a real signal worth seeing in test
 * output, not a silently-trusted `!`.
 */
function firstRow<T>(result: { rows: readonly T[] }, context: string): T {
  const row = result.rows[0];
  if (!row) throw new Error(`Expected at least one row from: ${context}`);
  return row;
}

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('OrdersService + HandoffCodesService — real end-to-end', () => {
  let pool: Pool;
  let ledger: LedgerService;
  let handoffCodes: HandoffCodesService;
  let orders: OrdersService;
  let customerId: string;
  let facilityPartnerId: string;
  let logisticsPartnerAuthId: string;
  let zoneId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ledger = new LedgerService(pool);
    handoffCodes = new HandoffCodesService();
    orders = new OrdersService(pool, ledger, handoffCodes);

    const customer = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`e2e-customer-${String(Date.now())}@example.com`],
    );
    customerId = firstRow(customer, 'insert auth.users (customer)').id;

    const facilityUser = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`e2e-facility-${String(Date.now())}@example.com`],
    );
    const facilityPartner = await pool.query<{ id: string }>(
      `insert into public.partners (auth_user_id, display_name, daily_capacity) values ($1, 'E2E Facility', 20) returning id`,
      [firstRow(facilityUser, 'insert auth.users (facility)').id],
    );
    facilityPartnerId = firstRow(facilityPartner, 'insert public.partners (facility)').id;

    const logisticsUser = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`e2e-rider-${String(Date.now())}@example.com`],
    );
    logisticsPartnerAuthId = firstRow(logisticsUser, 'insert auth.users (logistics)').id;
    await pool.query(
      `insert into public.partners (auth_user_id, display_name, daily_capacity) values ($1, 'E2E Rider', 20)`,
      [logisticsPartnerAuthId],
    );

    const zone = await pool.query<{ id: string }>(
      `insert into public.zones (name, city, country_code, boundary)
       values ('E2E Zone','Lagos','NG', ST_GeogFromText('POLYGON((3.4 6.4,3.6 6.4,3.6 6.6,3.4 6.6,3.4 6.4))'))
       returning id`,
    );
    zoneId = firstRow(zone, 'insert public.zones').id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeOrder(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into public.orders (service_id, customer_id, facility_partner_id, zone_id, total_amount)
       values ('laundry', $1, $2, $3, 500000) returning id`,
      [customerId, facilityPartnerId, zoneId],
    );
    return firstRow(result, 'insert public.orders').id;
  }

  it('a real transition into rider_arrived generates a real identity code atomically', async () => {
    const orderId = await makeOrder();

    await orders.transition({ orderId, type: 'order.paid', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.assigned', actor: 'system', actorId: 'system' });
    const outcome = await orders.transition({
      orderId,
      type: 'rider.arrived',
      actor: 'partner',
      actorId: logisticsPartnerAuthId,
    });

    expect(outcome.milestoneKey).toBe('rider_arrived');

    // Independent proof, bypassing OrdersService entirely: query the real
    // table directly.
    const code = await pool.query<{ code: string; attempts_remaining: number }>(
      `select code, attempts_remaining from public.handoff_codes where order_id = $1 and kind = 'identity' and consumed_at is null`,
      [orderId],
    );
    expect(code.rows).toHaveLength(1);
    expect(code.rows[0]?.code).toMatch(/^\d{4}$/);
    expect(code.rows[0]?.attempts_remaining).toBe(3);
  });

  it('transitionWithCode: wrong code rejects, decrements, and does NOT advance the milestone', async () => {
    const orderId = await makeOrder();
    await orders.transition({ orderId, type: 'order.paid', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.assigned', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.arrived', actor: 'partner', actorId: logisticsPartnerAuthId });

    await expect(
      orders.transitionWithCode({
        orderId,
        kind: 'identity',
        code: '0000',
        actor: 'partner',
        actorId: logisticsPartnerAuthId,
      }),
    ).rejects.toThrow(CodeMismatchError);

    // The order must NOT have advanced — still at rider_arrived (index 3).
    const projection = await orders.getOrderProjection(orderId);
    expect(projection?.milestoneKey).toBe('rider_arrived');

    // But the wrong attempt WAS durably recorded.
    const code = await pool.query<{ attempts_remaining: number }>(
      `select attempts_remaining from public.handoff_codes where order_id = $1 and kind = 'identity' and consumed_at is null`,
      [orderId],
    );
    expect(code.rows[0]?.attempts_remaining).toBe(2);
  });

  it('transitionWithCode: the CORRECT code advances the order atomically', async () => {
    const orderId = await makeOrder();
    await orders.transition({ orderId, type: 'order.paid', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.assigned', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.arrived', actor: 'partner', actorId: logisticsPartnerAuthId });

    const codeRow = await pool.query<{ code: string }>(
      `select code from public.handoff_codes where order_id = $1 and kind = 'identity' and consumed_at is null`,
      [orderId],
    );
    const realCode = firstRow(codeRow, 'select handoff_codes.code').code;

    const outcome = await orders.transitionWithCode({
      orderId,
      kind: 'identity',
      code: realCode,
      actor: 'partner',
      actorId: logisticsPartnerAuthId,
    });

    // Advanced past rider_arrived to count_verified.
    expect(outcome.milestoneKey).toBe('count_verified');

    // Independently confirm: the code is consumed, and a real
    // code.accepted event exists in order_events — not just claimed by
    // the return value.
    const consumed = await pool.query<{ consumed_at: string | null }>(
      `select consumed_at from public.handoff_codes where order_id = $1 and kind = 'identity'`,
      [orderId],
    );
    expect(consumed.rows[0]?.consumed_at).not.toBeNull();

    const event = await pool.query<{ type: string }>(
      `select type from public.order_events where order_id = $1 and type = 'code.accepted'`,
      [orderId],
    );
    expect(event.rows).toHaveLength(1);
  });

  it('3 wrong attempts locks the order — a 4th attempt with the correct code STILL fails', async () => {
    const orderId = await makeOrder();
    await orders.transition({ orderId, type: 'order.paid', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.assigned', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.arrived', actor: 'partner', actorId: logisticsPartnerAuthId });

    const codeRow = await pool.query<{ code: string }>(
      `select code from public.handoff_codes where order_id = $1 and kind = 'identity' and consumed_at is null`,
      [orderId],
    );
    const realCode = firstRow(codeRow, 'select handoff_codes.code').code;

    for (let i = 0; i < 2; i++) {
      await expect(
        orders.transitionWithCode({ orderId, kind: 'identity', code: 'wrong', actor: 'partner', actorId: logisticsPartnerAuthId }),
      ).rejects.toThrow(CodeMismatchError);
    }
    await expect(
      orders.transitionWithCode({ orderId, kind: 'identity', code: 'wrong', actor: 'partner', actorId: logisticsPartnerAuthId }),
    ).rejects.toThrow(CodeLockedOutError);

    // The real production guarantee: even the GENUINELY correct code is
    // now rejected. The order is frozen, not "one more try away".
    await expect(
      orders.transitionWithCode({ orderId, kind: 'identity', code: realCode, actor: 'partner', actorId: logisticsPartnerAuthId }),
    ).rejects.toThrow(CodeLockedOutError);

    const projection = await orders.getOrderProjection(orderId);
    expect(projection?.milestoneKey).toBe('rider_arrived'); // never advanced
  });

  it('listForPartner: the logistics partner sees this order once assigned as such', async () => {
    const orderId = await pool
      .query<{ id: string }>(
        `insert into public.orders (service_id, customer_id, logistics_partner_id, zone_id, total_amount)
         values ('courier', $1, (select id from public.partners where auth_user_id = $2), $3, 300000) returning id`,
        [customerId, logisticsPartnerAuthId, zoneId],
      )
      .then((r) => firstRow(r, 'insert public.orders (courier)').id);

    const list = await orders.listForPartner(logisticsPartnerAuthId);
    expect(list.some((o) => o.orderId === orderId)).toBe(true);
  });

  it('listForPartner: an unrelated partner does not see this order', async () => {
    const unrelatedUser = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`e2e-unrelated-${String(Date.now())}@example.com`],
    );
    const unrelatedUserId = firstRow(unrelatedUser, 'insert auth.users (unrelated)').id;
    await pool.query(`insert into public.partners (auth_user_id, display_name, daily_capacity) values ($1, 'Unrelated', 5)`, [
      unrelatedUserId,
    ]);

    const list = await orders.listForPartner(unrelatedUserId);
    expect(list).toHaveLength(0);
  });

  it('a real illegal transition (skipping the code milestone) is still rejected exactly as before', async () => {
    const orderId = await makeOrder();
    await orders.transition({ orderId, type: 'order.paid', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.assigned', actor: 'system', actorId: 'system' });
    await orders.transition({ orderId, type: 'rider.arrived', actor: 'partner', actorId: logisticsPartnerAuthId });

    // Attempting to skip straight past the code requirement via a normal
    // transition() call (not transitionWithCode) — proves the code
    // integration did not weaken the existing state machine guard.
    await expect(
      orders.transition({ orderId, type: 'bag.sealed', actor: 'partner', actorId: logisticsPartnerAuthId }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});
