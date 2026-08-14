/**
 * apps/api/src/payments/paystack.webhook.test.ts
 *
 * CLAUDE.md §17, §9 — this is attack #4 from the security review (forged
 * payment webhook). These tests attempt the actual attack: a forged
 * signature, a tampered amount, and a replayed reference. All three must
 * be rejected.
 */
import { describe, it, expect, vi } from 'vitest';
import { money } from '@provia/types';
import {
  verifyPaystackSignature,
  processPaystackWebhook,
  InvalidSignatureError,
  AmountMismatchError,
  type PaystackVerifyClient,
  type ProcessedReferenceStore,
} from './paystack.webhook';
import { createHmac } from 'node:crypto';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

function fakeStore(seed: readonly string[] = []): ProcessedReferenceStore {
  const seen = new Set(seed);
  return {
    has: (ref) => Promise.resolve(seen.has(ref)),
    markProcessed: (ref) => {
      seen.add(ref);
      return Promise.resolve();
    },
  };
}

describe('verifyPaystackSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref1', amount: 500000 } });
    expect(verifyPaystackSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a body signed with the wrong secret — the actual forgery attempt', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref1', amount: 500000 } });
    const forgedSignature = sign(body, 'attacker-guessed-secret');
    expect(verifyPaystackSignature(body, forgedSignature, SECRET)).toBe(false);
  });

  it('rejects a tampered body even with a signature that was valid for the ORIGINAL body', () => {
    const original = JSON.stringify({ event: 'charge.success', data: { reference: 'ref1', amount: 500000 } });
    const validSigForOriginal = sign(original);
    // Attacker takes a legitimately-signed webhook and edits the amount
    // after the fact, keeping the old signature.
    const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'ref1', amount: 5 } });
    expect(verifyPaystackSignature(tampered, validSigForOriginal, SECRET)).toBe(false);
  });

  it('rejects a missing signature header entirely', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref1', amount: 500000 } });
    expect(verifyPaystackSignature(body, '', SECRET)).toBe(false);
  });
});

describe('processPaystackWebhook — the full pipeline', () => {
  it('processes a genuinely valid webhook end to end', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'ref-ok', amount: 500000, currency: 'NGN', status: 'success' },
    });
    const verifyClient: PaystackVerifyClient = {
      verifyTransaction: () => Promise.resolve({ amount: 500000, currency: 'NGN', status: 'success' }),
    };
    const onVerified = vi.fn(async () => {});

    const result = await processPaystackWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      webhookSecret: SECRET,
      verifyClient,
      store: fakeStore(),
      onVerified,
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.verifiedAmount.amount).toBe(500000);
    expect(onVerified).toHaveBeenCalledOnce();
    expect(onVerified).toHaveBeenCalledWith('ref-ok', money(500000, 'NGN'));
  });

  it('THE FORGERY ATTACK: rejects a webhook with a forged signature and never calls onVerified', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'ref-attack', amount: 500000, currency: 'NGN', status: 'success' },
    });
    const verifyClient: PaystackVerifyClient = {
      verifyTransaction: () => Promise.resolve({ amount: 500000, currency: 'NGN', status: 'success' }),
    };
    const onVerified = vi.fn(async () => {});

    await expect(
      processPaystackWebhook({
        rawBody: body,
        signatureHeader: 'totally-made-up-signature-an-attacker-would-send',
        webhookSecret: SECRET,
        verifyClient,
        store: fakeStore(),
        onVerified,
      }),
    ).rejects.toThrow(InvalidSignatureError);

    expect(onVerified).not.toHaveBeenCalled();
  });

  it('THE AMOUNT-TAMPER ATTACK: rejects when the claimed amount does not match Paystack\'s own records', async () => {
    // Attacker has a genuinely valid signature (e.g. from a small real
    // payment) but edits the amount field to something bigger, hoping the
    // backend trusts the payload. It must not.
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'ref-tamper', amount: 50_000_000, currency: 'NGN', status: 'success' }, // claims ₦500,000
    });
    const verifyClient: PaystackVerifyClient = {
      // But Paystack's own API says the real charge was only ₦100.
      verifyTransaction: () => Promise.resolve({ amount: 10_000, currency: 'NGN', status: 'success' }),
    };
    const onVerified = vi.fn(async () => {});

    await expect(
      processPaystackWebhook({
        rawBody: body,
        signatureHeader: sign(body), // signature is genuinely valid for this (forged) body
        webhookSecret: SECRET,
        verifyClient,
        store: fakeStore(),
        onVerified,
      }),
    ).rejects.toThrow(AmountMismatchError);

    // The critical assertion: even with a VALID signature, a mismatched
    // amount must still block onVerified from ever running.
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('THE REPLAY ATTACK: a genuinely valid webhook replayed twice only triggers onVerified once', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'ref-replay', amount: 200000, currency: 'NGN', status: 'success' },
    });
    const verifyClient: PaystackVerifyClient = {
      verifyTransaction: () => Promise.resolve({ amount: 200000, currency: 'NGN', status: 'success' }),
    };
    const onVerified = vi.fn(async () => {});
    const store = fakeStore(); // shared across both calls, like a real DB-backed store would be

    const first = await processPaystackWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      webhookSecret: SECRET,
      verifyClient,
      store,
      onVerified,
    });
    const second = await processPaystackWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      webhookSecret: SECRET,
      verifyClient,
      store,
      onVerified,
    });

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(onVerified).toHaveBeenCalledOnce(); // NOT twice — this is the idempotency guarantee
  });

  it('rejects when Paystack itself reports a non-success status, regardless of signature validity', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'ref-pending', amount: 100000, currency: 'NGN', status: 'success' },
    });
    const verifyClient: PaystackVerifyClient = {
      verifyTransaction: () => Promise.resolve({ amount: 100000, currency: 'NGN', status: 'abandoned' }),
    };
    const onVerified = vi.fn(async () => {});

    await expect(
      processPaystackWebhook({
        rawBody: body,
        signatureHeader: sign(body),
        webhookSecret: SECRET,
        verifyClient,
        store: fakeStore(),
        onVerified,
      }),
    ).rejects.toThrow(/status "abandoned"/);

    expect(onVerified).not.toHaveBeenCalled();
  });

  it('ignores non-charge.success events without error and without calling onVerified', async () => {
    const body = JSON.stringify({ event: 'transfer.success', data: { reference: 'ref-x', amount: 1, currency: 'NGN', status: 'success' } });
    const onVerified = vi.fn(async () => {});
    const result = await processPaystackWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      webhookSecret: SECRET,
      verifyClient: { verifyTransaction: () => Promise.resolve({ amount: 1, currency: 'NGN', status: 'success' }) },
      store: fakeStore(),
      onVerified,
    });
    expect(result.alreadyProcessed).toBe(true);
    expect(onVerified).not.toHaveBeenCalled();
  });
});
