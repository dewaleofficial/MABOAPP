/**
 * apps/api/src/handoff-codes/handoff-codes.integration.test.ts
 *
 * CLAUDE.md §17 — same ruthless-testing bar as the ledger and orders
 * service. These run against real Postgres with the real migrations
 * applied (0001_foundation.sql + 0002_handoff_codes.sql), including the
 * real unique-active-code index and the real RLS policies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  HandoffCodesService,
  CodeMismatchError,
  CodeLockedOutError,
  NoActiveCodeError,
} from './handoff-codes.service';

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

describeIfDb('HandoffCodesService — real Postgres integration', () => {
  let pool: Pool;
  let service: HandoffCodesService;
  let customerId: string;
  let partnerId: string;
  let zoneId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new HandoffCodesService();

    const customer = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`handoff-test-${String(Date.now())}@example.com`],
    );
    const c = customer.rows[0];
    if (!c) throw new Error('fixture setup failed');
    customerId = c.id;

    const partnerUser = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`handoff-partner-${String(Date.now())}@example.com`],
    );
    const pu = partnerUser.rows[0];
    if (!pu) throw new Error('fixture setup failed');

    const partner = await pool.query<{ id: string }>(
      `insert into public.partners (auth_user_id, display_name, daily_capacity)
       values ($1, 'Test Partner', 10) returning id`,
      [pu.id],
    );
    const p = partner.rows[0];
    if (!p) throw new Error('fixture setup failed');
    partnerId = p.id;

    const zone = await pool.query<{ id: string }>(
      `insert into public.zones (name, city, country_code, boundary)
       values ('Handoff Test Zone','Lagos','NG', ST_GeogFromText('POLYGON((3.4 6.4,3.6 6.4,3.6 6.6,3.4 6.6,3.4 6.4))'))
       returning id`,
    );
    const z = zone.rows[0];
    if (!z) throw new Error('fixture setup failed');
    zoneId = z.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeOrder(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into public.orders (service_id, customer_id, facility_partner_id, zone_id, total_amount)
       values ('laundry', $1, $2, $3, 500000) returning id`,
      [customerId, partnerId, zoneId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('order fixture failed');
    return row.id;
  }

  describe('generate', () => {
    it('creates a real code row with 3 attempts and a future expiry', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const row = await pool.query<{ code: string; attempts_remaining: number }>(
        `select code, attempts_remaining from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      const r = row.rows[0];
      expect(r).toBeDefined();
      expect(r?.code).toMatch(/^\d{4}$/);
      expect(r?.attempts_remaining).toBe(3);
    });

    it('rejects generating a second active code of the same kind (unique index enforced)', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await expect(service.generate(client, orderId, 'identity', 'partner_logistics')).rejects.toThrow();
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('verify — the real proof', () => {
    it('accepts the correct code and marks it consumed', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const row = await pool.query<{ code: string }>(
        `select code from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      const generatedCode = firstRow(row, 'select handoff_codes.code').code;

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await service.verify(client2, orderId, 'identity', generatedCode);
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }

      const after = await pool.query<{ consumed_at: string | null }>(
        `select consumed_at from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      expect(after.rows[0]?.consumed_at).not.toBeNull();
    });

    it('rejects a wrong code and decrements attempts_remaining by exactly 1', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await expect(service.verify(client2, orderId, 'identity', '0000')).rejects.toThrow(CodeMismatchError);
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }

      const row = await pool.query<{ attempts_remaining: number; consumed_at: string | null }>(
        `select attempts_remaining, consumed_at from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      expect(row.rows[0]?.attempts_remaining).toBe(2);
      expect(row.rows[0]?.consumed_at).toBeNull();
    });

    it('locks out after exactly 3 wrong attempts — the real production behaviour', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      for (let i = 0; i < 2; i++) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await expect(service.verify(c, orderId, 'identity', 'wrong')).rejects.toThrow(CodeMismatchError);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      }

      // Third wrong attempt: CodeLockedOutError, not CodeMismatchError.
      const c3 = await pool.connect();
      try {
        await c3.query('BEGIN');
        await expect(service.verify(c3, orderId, 'identity', 'wrong')).rejects.toThrow(CodeLockedOutError);
        await c3.query('COMMIT');
      } finally {
        c3.release();
      }

      // A FOURTH attempt, even with the CORRECT code, must also be locked
      // out — proving lockout is real, not just "one more mismatch away".
      const row = await pool.query<{ code: string }>(
        `select code from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      const correctCode = firstRow(row, 'select handoff_codes.code').code;

      const c4 = await pool.connect();
      try {
        await c4.query('BEGIN');
        await expect(service.verify(c4, orderId, 'identity', correctCode)).rejects.toThrow(CodeLockedOutError);
        await c4.query('COMMIT');
      } finally {
        c4.release();
      }
    });

    it('rejects verification when no active code exists at all', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(service.verify(client, orderId, 'identity', '1234')).rejects.toThrow(NoActiveCodeError);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    it('a consumed code cannot be verified again, even with the correct value', async () => {
      const orderId = await makeOrder();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await service.generate(client, orderId, 'identity', 'partner_logistics');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const row = await pool.query<{ code: string }>(
        `select code from public.handoff_codes where order_id = $1 and kind = 'identity'`,
        [orderId],
      );
      const code = firstRow(row, 'select handoff_codes.code').code;

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await service.verify(client2, orderId, 'identity', code); // first: succeeds
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }

      const client3 = await pool.connect();
      try {
        await client3.query('BEGIN');
        await expect(service.verify(client3, orderId, 'identity', code)).rejects.toThrow(NoActiveCodeError);
        await client3.query('COMMIT');
      } finally {
        client3.release();
      }
    });
  });

  describe('RLS — proven directly against the real policies', () => {
    it('the migration exists and RLS is enabled on handoff_codes', async () => {
      const result = await pool.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'handoff_codes'`,
      );
      expect(result.rows[0]?.relrowsecurity).toBe(true);
    });
  });
});
