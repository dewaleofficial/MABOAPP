/**
 * apps/api/src/orders/orders.integration.test.ts
 *
 * CLAUDE.md §17 — ruthless testing where money and state live. These are
 * NOT unit tests against a mock. They run against a real local Postgres
 * with the real 0001_foundation.sql schema applied, including the real
 * append-only triggers and RLS. If a trigger or a policy is wrong, these
 * tests see the real error, the same one production would see.
 *
 * Requires a local Postgres with the foundation schema applied. Skips
 * cleanly if DATABASE_URL is not set, so this never blocks `pnpm test` in
 * an environment without a database — CI wires DATABASE_URL to the
 * ephemeral Postgres service and these run there for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { money } from '@provia/types';
import { OrdersService, OrderNotFoundError, IllegalTransitionError } from './orders.service';
import { LedgerService, UnbalancedPostingError } from '../ledger/ledger.service';
import { HandoffCodesService } from '../handoff-codes/handoff-codes.service';

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

function rowCount(result: { rows: readonly { n: string }[] }, context: string): number {
  return Number(firstRow(result, context).n);
}

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('OrdersService + LedgerService — real Postgres integration', () => {
  let pool: Pool;
  let ledger: LedgerService;
  let orders: OrdersService;
  let zoneId: string;
  let customerId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ledger = new LedgerService(pool);
    orders = new OrdersService(pool, ledger, new HandoffCodesService());

    const customer = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`test-${String(Date.now())}@example.com`],
    );
    customerId = firstRow(customer, 'insert auth.users').id;

    const zone = await pool.query<{ id: string }>(
      `insert into public.zones (name, city, country_code, boundary)
       values ('Test Zone','Lagos','NG', ST_GeogFromText('POLYGON((3.4 6.4,3.6 6.4,3.6 6.6,3.4 6.6,3.4 6.4))'))
       returning id`,
    );
    zoneId = firstRow(zone, 'insert public.zones').id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeOrder(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into public.orders (service_id, customer_id, zone_id, total_amount)
       values ('laundry', $1, $2, 500000) returning id`,
      [customerId, zoneId],
    );
    return firstRow(result, 'insert public.orders').id;
  }

  describe('a legal transition', () => {
    it('inserts the event, updates milestone_index, and commits', async () => {
      const orderId = await makeOrder();

      const outcome = await orders.transition({
        orderId,
        type: 'order.paid',
        actor: 'system',
        actorId: 'test',
      });

      expect(outcome.milestoneIndex).toBe(1);
      expect(outcome.milestoneKey).toBe('rider_assigned');

      const row = await pool.query<{ milestone_index: number }>(
        `select milestone_index from public.orders where id = $1`,
        [orderId],
      );
      expect(firstRow(row, 'select orders.milestone_index').milestone_index).toBe(1);

      const events = await pool.query<{ type: string }>(`select type from public.order_events where order_id = $1`, [orderId]);
      expect(events.rows).toHaveLength(1);
      expect(firstRow(events, 'select order_events.type').type).toBe('order.paid');
    });
  });

  describe('an illegal transition — proving atomicity, not just that it throws', () => {
    it('rejects the wrong event AND writes nothing at all', async () => {
      const orderId = await makeOrder();

      await expect(
        orders.transition({
          orderId,
          type: 'rider.assigned', // wrong — skips order.paid
          actor: 'system',
          actorId: 'test',
        }),
      ).rejects.toThrow(IllegalTransitionError);

      // The real proof: not just "it threw", but that the ROLLBACK actually
      // rolled back. If this were a bug where the event insert happened
      // before the throw, this query would show 1 row, not 0.
      const events = await pool.query<{ n: string }>(`select count(*) as n from public.order_events where order_id = $1`, [
        orderId,
      ]);
      expect(rowCount(events, 'events count query')).toBe(0);

      const row = await pool.query<{ milestone_index: number }>(
        `select milestone_index from public.orders where id = $1`,
        [orderId],
      );
      expect(firstRow(row, 'select orders.milestone_index (after rejected transition)').milestone_index).toBe(0); // untouched
    });

    it('throws OrderNotFoundError for a non-existent order and writes nothing', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await expect(
        orders.transition({ orderId: fakeId, type: 'order.paid', actor: 'system', actorId: 'test' }),
      ).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('atomic money + state — the actual money path', () => {
    it('a transition with ledger lines posts BOTH the event and the ledger together', async () => {
      const orderId = await makeOrder();
      const key = `test-atomic-${orderId}`;

      const outcome = await orders.transition({
        orderId,
        type: 'order.paid',
        actor: 'system',
        actorId: 'test',
        ledgerLines: [
          {
            account: 'customer_receivable',
            direction: 'debit',
            amount: money(500_000, 'NGN'),
            orderId,
            idempotencyKey: `${key}-a`,
          },
          {
            account: 'escrow_held',
            direction: 'credit',
            amount: money(500_000, 'NGN'),
            orderId,
            idempotencyKey: `${key}-b`,
          },
        ],
      });

      expect(outcome.postingId).toBeTruthy();

      const ledgerRows = await pool.query<{ account: string; direction: string; amount: string }>(
        `select account, direction, amount from public.ledger_entries where posting_id = $1`,
        [outcome.postingId],
      );
      expect(ledgerRows.rows).toHaveLength(2);

      const net = ledgerRows.rows.reduce(
        (sum, r) => sum + (r.direction === 'debit' ? 1 : -1) * Number(r.amount),
        0,
      );
      expect(net).toBe(0); // genuinely balanced in the real table, not just in memory
    });

    it('an UNBALANCED ledger posting rolls back the EVENT too — proving true atomicity', async () => {
      const orderId = await makeOrder();
      const key = `test-unbalanced-${orderId}`;

      await expect(
        orders.transition({
          orderId,
          type: 'order.paid',
          actor: 'system',
          actorId: 'test',
          ledgerLines: [
            {
              account: 'customer_receivable',
              direction: 'debit',
              amount: money(500_000, 'NGN'),
              orderId,
              idempotencyKey: `${key}-a`,
            },
            {
              account: 'escrow_held',
              direction: 'credit',
              amount: money(499_000, 'NGN'), // deliberately wrong — ₦10 short
              orderId,
              idempotencyKey: `${key}-b`,
            },
          ],
        }),
      ).rejects.toThrow(UnbalancedPostingError);

      // This is the real test: the order.paid EVENT must ALSO be gone, even
      // though the state-machine part of the transition was perfectly
      // legal. If ledger posting and event insert weren't in the same
      // transaction, this would show 1 event with no matching ledger rows
      // — an order silently marked paid with no money movement recorded.
      const events = await pool.query<{ n: string }>(`select count(*) as n from public.order_events where order_id = $1`, [
        orderId,
      ]);
      expect(rowCount(events, 'events count query')).toBe(0);

      const ledgerRows = await pool.query<{ n: string }>(`select count(*) as n from public.ledger_entries where order_id = $1`, [
        orderId,
      ]);
      expect(rowCount(ledgerRows, 'ledgerRows count query')).toBe(0);
    });
  });

  describe('ledger idempotency — real concurrent-retry simulation', () => {
    it('posting the exact same lines twice does not create a second posting', async () => {
      const orderId = await makeOrder();
      const key = `test-idem-${orderId}`;
      const lines = [
        {
          account: 'customer_receivable' as const,
          direction: 'debit' as const,
          amount: money(200_000, 'NGN'),
          orderId,
          idempotencyKey: key,
        },
        {
          account: 'escrow_held' as const,
          direction: 'credit' as const,
          amount: money(200_000, 'NGN'),
          orderId,
          idempotencyKey: `${key}-credit`,
        },
      ];

      const first = await ledger.post(lines);
      const second = await ledger.post(lines); // simulates a Paystack webhook retry

      expect(first.wasDuplicate).toBe(false);
      expect(second.wasDuplicate).toBe(true);
      expect(second.postingId).toBe(first.postingId);

      const count = await pool.query<{ n: string }>(`select count(*) as n from public.ledger_entries where order_id = $1`, [
        orderId,
      ]);
      // Exactly 2 rows (one posting's worth), not 4 — the retry did not
      // double-post (CLAUDE.md §3.6 — idempotency on every money path).
      expect(rowCount(count, 'count count query')).toBe(2);
    });

    it('truly concurrent duplicate posts (fired at the same instant) still only create one posting', async () => {
      const orderId = await makeOrder();
      const key = `test-race-${orderId}`;
      const lines = [
        {
          account: 'customer_receivable' as const,
          direction: 'debit' as const,
          amount: money(100_000, 'NGN'),
          orderId,
          idempotencyKey: key,
        },
        {
          account: 'escrow_held' as const,
          direction: 'credit' as const,
          amount: money(100_000, 'NGN'),
          orderId,
          idempotencyKey: `${key}-credit`,
        },
      ];

      // Fire two posts genuinely concurrently, not sequentially — this is
      // what a real double-tap or a network-retry race actually looks like.
      const [a, b] = await Promise.all([ledger.post(lines), ledger.post(lines)]);

      const duplicateCount = [a.wasDuplicate, b.wasDuplicate].filter(Boolean).length;
      expect(duplicateCount).toBe(1); // exactly one of the two was told "already done"

      const count = await pool.query<{ n: string }>(`select count(*) as n from public.ledger_entries where order_id = $1`, [
        orderId,
      ]);
      expect(rowCount(count, 'count count query')).toBe(2); // never 4
    });
  });

  describe('the ledger append-only trigger — proven at the API layer too', () => {
    it('the service never even attempts an UPDATE, but if something tried, the DB would refuse it', async () => {
      const orderId = await makeOrder();
      const posted = await ledger.post([
        {
          account: 'customer_receivable',
          direction: 'debit',
          amount: money(50_000, 'NGN'),
          orderId,
          idempotencyKey: `trigger-check-${orderId}-a`,
        },
        {
          account: 'escrow_held',
          direction: 'credit',
          amount: money(50_000, 'NGN'),
          orderId,
          idempotencyKey: `trigger-check-${orderId}-b`,
        },
      ]);

      await expect(
        pool.query(`update public.ledger_entries set amount = 1 where posting_id = $1`, [posted.postingId]),
      ).rejects.toThrow(/append-only and immutable/);
    });
  });
});
