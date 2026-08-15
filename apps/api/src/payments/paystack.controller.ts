/**
 * apps/api/src/payments/paystack.controller.ts
 *
 * CLAUDE.md §8, §9 — this endpoint is PUBLIC (no AuthGuard — Paystack is
 * not a logged-in user and cannot present a Supabase JWT). Its entire
 * security model is the HMAC signature check inside
 * processPaystackWebhook(), already proven against all three named
 * attacks yesterday (forged signature, tampered amount, replay).
 *
 * The one thing this controller must get right that a unit test cannot
 * fully prove: it must receive the RAW, unparsed request body. Signature
 * verification hashes the exact bytes Paystack sent; if Nest's body
 * parser has already turned this into a JSON object and re-serialised it
 * before this handler sees it, the hash will not match even for a
 * genuinely legitimate webhook, and the whole verification is broken
 * silently. See main.ts for the raw-body wiring this depends on.
 */

import { Controller, Inject, Post, Req, Res, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  processPaystackWebhook,
  type PaystackVerifyClient,
  type ProcessedReferenceStore,
} from './paystack.webhook';
import { LedgerService } from '../ledger/ledger.service';
import { PAYSTACK_WEBHOOK_SECRET, PAYSTACK_VERIFY_CLIENT } from '../common/pg.token';

/**
 * Minimal in-memory store as a placeholder. A real deployment backs this
 * with a table (e.g. a unique index on payment_reference), not memory —
 * this would lose idempotency across a restart. Flagged explicitly so it
 * is not mistaken for production-ready.
 */
class InMemoryProcessedStore implements ProcessedReferenceStore {
  private readonly seen = new Set<string>();
  has(ref: string): Promise<boolean> {
    return Promise.resolve(this.seen.has(ref));
  }
  markProcessed(ref: string): Promise<void> {
    this.seen.add(ref);
    return Promise.resolve();
  }
}

@Controller('webhooks/paystack')
export class PaystackController {
  private readonly store = new InMemoryProcessedStore();

  constructor(
    @Inject(PAYSTACK_WEBHOOK_SECRET) private readonly webhookSecret: string,
    @Inject(PAYSTACK_VERIFY_CLIENT) private readonly verifyClient: PaystackVerifyClient,
    private readonly ledger: LedgerService,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    // req.body here MUST be the raw Buffer/string, not a parsed object —
    // see the header comment and main.ts.
    const rawBody: string = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    const signatureHeader = req.headers['x-paystack-signature'];

    try {
      const result = await processPaystackWebhook({
        rawBody,
        signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : '',
        webhookSecret: this.webhookSecret,
        verifyClient: this.verifyClient,
        store: this.store,
        onVerified: async (reference, amount) => {
          // Post the escrow hold. In the full implementation this also
          // resolves the order from the reference and calls
          // orders.transition() with these ledgerLines so the event and
          // the money movement commit atomically together, exactly as
          // proven in orders.integration.test.ts yesterday. Kept as a
          // direct ledger post here, scoped narrowly, rather than
          // guessing at order-resolution logic that has not been built
          // or tested yet.
          await this.ledger.post([
            {
              account: 'customer_receivable',
              direction: 'debit',
              amount,
              idempotencyKey: `paystack-${reference}-receivable`,
            },
            {
              account: 'escrow_held',
              direction: 'credit',
              amount,
              idempotencyKey: `paystack-${reference}-escrow`,
            },
          ]);
        },
      });

      // Always 200 on a successfully PROCESSED webhook, including the
      // "already processed" / "not charge.success" cases — Paystack
      // retries on any non-2xx, and retrying something we already
      // correctly handled achieves nothing but noise.
      res.status(HttpStatus.OK).json({ received: true, reference: result.reference });
    } catch (err) {
      // A rejected webhook (bad signature, amount mismatch, wrong status)
      // returns a non-2xx deliberately — CLAUDE.md §9 wants these visible
      // and alertable, not swallowed into a fake 200.
      const message = err instanceof Error ? err.message : 'Webhook processing failed';
      res.status(HttpStatus.BAD_REQUEST).json({ received: false, error: message });
    }
  }
}
