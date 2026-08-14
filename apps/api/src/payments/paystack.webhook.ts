/**
 * apps/api/src/payments/paystack.webhook.ts
 *
 * CLAUDE.md §8, §9 — verify the HMAC signature, then re-verify the amount
 * against the Paystack API before releasing anything. Never trust the
 * payload. This is one of the two named attack vectors in the security
 * review (#4, forged payment webhook) — treat this file with the same
 * scrutiny as the ledger itself, because it is the entry point that
 * ultimately causes money to move.
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §8, §9, §18).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '@provia/types';
import { money } from '@provia/types';

export class InvalidSignatureError extends Error {
  constructor() {
    super('Webhook signature does not match. Rejecting without processing (CLAUDE.md §9).');
    this.name = 'InvalidSignatureError';
  }
}

export class AmountMismatchError extends Error {
  constructor(
    public readonly claimed: number,
    public readonly verified: number,
  ) {
    super(
      `Webhook payload claims ${String(claimed)} kobo but the Paystack API reports ` +
        `${String(verified)} kobo for this reference. Refusing to process — the ` +
        `payload is never trusted for amount (CLAUDE.md §8).`,
    );
    this.name = 'AmountMismatchError';
  }
}

export interface PaystackChargeEvent {
  // Paystack sends many event types; 'charge.success' is the only one this
  // module acts on, but the field is genuinely just a string on the wire —
  // narrowing it to a literal union would be a lie about what we validate.
  readonly event: string;
  readonly data: {
    readonly reference: string;
    readonly amount: number; // kobo, AS CLAIMED — never trusted alone
    readonly currency: string;
    readonly status: string;
  };
}

/**
 * Runtime shape check for a parsed JSON body claiming to be a Paystack
 * charge event. This is what makes the `as PaystackChargeEvent` cast
 * upstream honest — an untrusted body is validated before any field on it
 * is read, not merely asserted to have a shape (CLAUDE.md §9).
 */
function isPaystackChargeEvent(value: unknown): value is PaystackChargeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['event'] !== 'string') return false;
  if (typeof v['data'] !== 'object' || v['data'] === null) return false;
  const d = v['data'] as Record<string, unknown>;
  return (
    typeof d['reference'] === 'string' &&
    typeof d['amount'] === 'number' &&
    typeof d['currency'] === 'string' &&
    typeof d['status'] === 'string'
  );
}

/**
 * Verify the raw request body against Paystack's HMAC-SHA512 signature.
 *
 * Takes the RAW body string, not a parsed object — signature verification
 * must happen over the exact bytes Paystack sent, before any JSON parsing
 * that could normalise whitespace or key order and invalidate the hash.
 *
 * Uses a constant-time comparison so response timing cannot be used to
 * brute-force the signature byte by byte.
 */
export function verifyPaystackSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

/** Injected so this is testable without a live Paystack account (CLAUDE.md §17). */
export interface PaystackVerifyClient {
  verifyTransaction(reference: string): Promise<{ amount: number; currency: string; status: string }>;
}

export interface ProcessWebhookResult {
  readonly reference: string;
  readonly verifiedAmount: Money;
  readonly alreadyProcessed: boolean;
}

/** Tracks references already processed, so a Paystack retry (they do retry
 *  on any non-2xx) never runs the downstream escrow-hold logic twice.
 *  A real deployment backs this with a unique index on payment_reference
 *  in the ledger or a dedicated webhook_receipts table — the interface
 *  here is deliberately storage-agnostic so it can be swapped for either. */
export interface ProcessedReferenceStore {
  has(reference: string): Promise<boolean>;
  markProcessed(reference: string): Promise<void>;
}

/**
 * The full, safe pipeline: verify signature -> parse -> re-verify amount
 * against Paystack's own API -> check idempotency -> hand off to the
 * caller-supplied `onVerified` callback (which is where OrdersService /
 * LedgerService actually do something, kept out of this file so payment
 * verification stays testable in isolation from the database).
 */
export async function processPaystackWebhook(params: {
  rawBody: string;
  signatureHeader: string;
  webhookSecret: string;
  verifyClient: PaystackVerifyClient;
  store: ProcessedReferenceStore;
  onVerified: (reference: string, amount: Money) => Promise<void>;
}): Promise<ProcessWebhookResult> {
  const { rawBody, signatureHeader, webhookSecret, verifyClient, store, onVerified } = params;

  if (!verifyPaystackSignature(rawBody, signatureHeader, webhookSecret)) {
    throw new InvalidSignatureError();
  }

  const parsed: unknown = JSON.parse(rawBody);
  if (!isPaystackChargeEvent(parsed)) {
    // A signature can be valid for a body that is nonetheless not shaped
    // like a Paystack charge event — e.g. Paystack changes their payload,
    // or this endpoint is hit with something else entirely. Refuse rather
    // than trust a cast (CLAUDE.md §9 — this is the named webhook attack surface).
    throw new Error('Webhook body does not match the expected Paystack charge event shape.');
  }
  const event = parsed;

  if (event.event !== 'charge.success') {
    // Not an error — Paystack sends many event types; we only act on
    // charge.success. Anything else is acknowledged and ignored.
    return {
      reference: event.data.reference,
      verifiedAmount: money(0, 'NGN'),
      alreadyProcessed: true,
    };
  }

  const { reference } = event.data;

  if (await store.has(reference)) {
    return { reference, verifiedAmount: money(event.data.amount, 'NGN'), alreadyProcessed: true };
  }

  // The payload's amount is NEVER used for anything beyond this comparison.
  // What actually gets posted to the ledger is verified.amount, fetched
  // fresh from Paystack's own API (CLAUDE.md §8).
  const verified = await verifyClient.verifyTransaction(reference);

  if (verified.amount !== event.data.amount) {
    throw new AmountMismatchError(event.data.amount, verified.amount);
  }
  if (verified.status !== 'success') {
    throw new Error(`Paystack reports status "${verified.status}" for ${reference}, not "success".`);
  }

  const verifiedMoney = money(verified.amount, verified.currency as Money['currency']);

  await onVerified(reference, verifiedMoney);
  await store.markProcessed(reference);

  return { reference, verifiedAmount: verifiedMoney, alreadyProcessed: false };
}
