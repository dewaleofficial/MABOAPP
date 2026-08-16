/**
 * apps/api/src/app.module.ts
 *
 * Wires together everything built and proven so far. Every provider here
 * is either already tested (OrdersService, LedgerService, the webhook
 * pipeline) or newly built and tested today (AuthGuard). This file's only
 * job is dependency injection — no business logic lives here.
 */

import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { LedgerService } from './ledger/ledger.service';
import { PaystackController } from './payments/paystack.controller';
import { AuthGuard } from './auth/auth.guard';
import {
  PG_POOL,
  SUPABASE_JWKS_URL,
  SUPABASE_JWT_SECRET,
  PAYSTACK_WEBHOOK_SECRET,
  PAYSTACK_VERIFY_CLIENT,
} from './common/pg.token';
import type { PaystackVerifyClient } from './payments/paystack.webhook';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Refusing to start.`);
  }
  return value;
}

/**
 * A thin wrapper around the real Paystack "verify transaction" API call.
 * Kept as its own small class (rather than an inline fetch in the
 * controller) so it can be swapped for the fake client used in
 * paystack.webhook.test.ts without touching any other code — that
 * substitutability is what let yesterday's tests simulate all three
 * webhook attacks without a live Paystack account.
 */
class RealPaystackVerifyClient implements PaystackVerifyClient {
  constructor(private readonly secretKey: string) {}

  async verifyTransaction(reference: string): Promise<{ amount: number; currency: string; status: string }> {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    if (!response.ok) {
      throw new Error(`Paystack verify API returned ${String(response.status)} for reference ${reference}`);
    }
    const body = (await response.json()) as {
      data?: { amount?: number; currency?: string; status?: string };
    };
    return {
      amount: body.data?.amount ?? 0,
      currency: body.data?.currency ?? 'NGN',
      status: body.data?.status ?? 'unknown',
    };
  }
}

@Module({
  controllers: [OrdersController, PaystackController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: requireEnv('DATABASE_URL') }),
    },
    LedgerService,
    OrdersService,
    {
      provide: SUPABASE_JWT_SECRET,
      useFactory: () => requireEnv('SUPABASE_JWT_SECRET'),
    },
    {
      provide: SUPABASE_JWKS_URL,
      useFactory: () => requireEnv('SUPABASE_JWKS_URL'),
    },
    AuthGuard,
    {
      provide: PAYSTACK_WEBHOOK_SECRET,
      useFactory: () => requireEnv('PAYSTACK_WEBHOOK_SECRET'),
    },
    {
      provide: PAYSTACK_VERIFY_CLIENT,
      useFactory: (): PaystackVerifyClient => new RealPaystackVerifyClient(requireEnv('PAYSTACK_SECRET_KEY')),
    },
  ],
})
/**
 * A NestJS @Module() class is correctly empty by framework convention —
 * all behaviour lives in the decorator metadata above, not in class members.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
