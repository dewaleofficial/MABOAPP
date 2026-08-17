/**
 * apps/api/src/handoff-codes/handoff-codes.service.ts
 *
 * CLAUDE.md §11 — the three/four-code handshake is the trust backbone of
 * the product. This service is its real implementation: generation,
 * display-authorization, verification, and lockout.
 *
 * Two rules that must never be violated, both enforced structurally here,
 * not just by convention:
 *
 *   1. A code is only ever generated INSIDE the same database transaction
 *      as the milestone event that requires it. This service never opens
 *      its own transaction — every method here takes a PoolClient that the
 *      caller (OrdersService.transition()) already has open. If a code
 *      generation fails, the whole transition rolls back with it — an
 *      order can never reach a code-requiring milestone with no code to
 *      show for it.
 *
 *   2. Reading the raw code value never happens through this service.
 *      Display authorization is enforced entirely by the RLS policies on
 *      handoff_codes (infra/migrations/0002_handoff_codes.sql) — a
 *      customer's own Supabase session, querying directly, is how the code
 *      reaches them. This service only ever WRITES: generates, decrements
 *      attempts, marks consumed. It has no "getCode" method, deliberately
 *      — that would be a second path around RLS.
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §11, §18).
 */

import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomInt } from 'node:crypto';
import type { HandoffCodeKind } from '@provia/types';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 3;

export class CodeLockedOutError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly kind: HandoffCodeKind,
  ) {
    super(
      `Handoff code "${kind}" for order ${orderId} has been locked out after ` +
        `${String(MAX_ATTEMPTS)} failed attempts. This order is frozen for ops ` +
        `review (CLAUDE.md §11) — it cannot be advanced by retrying the code.`,
    );
    this.name = 'CodeLockedOutError';
  }
}

export class CodeMismatchError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly kind: HandoffCodeKind,
    public readonly attemptsRemaining: number,
  ) {
    super(
      `Incorrect code for order ${orderId} ("${kind}"). ` +
        `${String(attemptsRemaining)} attempt(s) remaining before this order is frozen for review.`,
    );
    this.name = 'CodeMismatchError';
  }
}

export class NoActiveCodeError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly kind: HandoffCodeKind,
  ) {
    super(`No active "${kind}" code exists for order ${orderId}.`);
    this.name = 'NoActiveCodeError';
  }
}

/** Cryptographically random 4-digit string, zero-padded — never Math.random()
 *  (CLAUDE.md §4's no-restricted-imports rule already forbids it repo-wide;
 *  this is the reference implementation for why). */
function generateFourDigitCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

@Injectable()
export class HandoffCodesService {
  /**
   * Generate a new active code for this order/kind, inside the caller's
   * transaction. Throws (via the unique index on handoff_codes) if an
   * active code of this kind already exists — that is a genuine bug
   * upstream (attempting to re-enter a milestone that already has a live
   * code), not something this method silently papers over.
   */
  async generate(
    client: PoolClient,
    orderId: string,
    kind: HandoffCodeKind,
    enteredBy: 'partner_logistics' | 'partner_facility',
  ): Promise<{ id: string }> {
    const code = generateFourDigitCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    const result = await client.query<{ id: string }>(
      `insert into public.handoff_codes (order_id, kind, code, entered_by, expires_at)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [orderId, kind, code, enteredBy, expiresAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Insert into handoff_codes returned no row — should be impossible.');
    return { id: row.id };
  }

  /**
   * Verify a code the rider (or facility) claims to have been given.
   * On success: marks the code consumed, returns normally — the CALLER
   * (OrdersService.transition()) is responsible for then appending the
   * code.accepted event and advancing the milestone, in the SAME
   * transaction, so verification and advancement are atomic together.
   *
   * On a wrong guess: decrements attempts_remaining. At zero, the code
   * (and by extension the order) is locked — CodeLockedOutError, not a
   * silent failure the caller could retry past.
   */
  async verify(
    client: PoolClient,
    orderId: string,
    kind: HandoffCodeKind,
    submittedCode: string,
  ): Promise<void> {
    // Row-level lock: two simultaneous verify attempts for the same code
    // (e.g. a double-tap) must not both see attemptsRemaining=1 and both
    // succeed — `for update` serialises them within this transaction.
    const result = await client.query<{
      id: string;
      code: string;
      attempts_remaining: number;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `select id, code, attempts_remaining, expires_at, consumed_at
         from public.handoff_codes
        where order_id = $1 and kind = $2 and consumed_at is null
        for update`,
      [orderId, kind],
    );

    const row = result.rows[0];
    if (!row) throw new NoActiveCodeError(orderId, kind);

    if (row.attempts_remaining <= 0) {
      throw new CodeLockedOutError(orderId, kind);
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      // Expiry is not a "retry with a fresh code" path either — an
      // expired handoff means the rider and customer were never in sync
      // in time; that is itself an operational event worth surfacing,
      // not silently regenerating around.
      throw new NoActiveCodeError(orderId, kind);
    }

    if (row.code !== submittedCode) {
      const remaining = row.attempts_remaining - 1;
      await client.query(
        `update public.handoff_codes set attempts_remaining = $1 where id = $2`,
        [remaining, row.id],
      );
      if (remaining <= 0) {
        throw new CodeLockedOutError(orderId, kind);
      }
      throw new CodeMismatchError(orderId, kind, remaining);
    }

    await client.query(
      `update public.handoff_codes set consumed_at = now() where id = $1`,
      [row.id],
    );
  }
}
