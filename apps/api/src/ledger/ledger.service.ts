/**
 * apps/api/src/ledger/ledger.service.ts
 *
 * CLAUDE.md §8 — the ledger is double-entry, immutable. Every money
 * movement is a balanced pair (or set) of entries. This service is the
 * ONLY code path allowed to write to ledger_entries. Nothing else in the
 * backend inserts a row here directly.
 *
 * Balance is enforced in application code before the insert is attempted,
 * AND the database schema itself makes update/delete impossible (see
 * infra/migrations/0001_foundation.sql — the reject_ledger_mutation
 * trigger). This is defence in depth: even if this service had a bug that
 * let an unbalanced posting through, nobody — not even a compromised
 * service_role connection — can later edit or delete what was written.
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §8, §18).
 */

import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Money, LedgerAccount, BenefitFundedBy } from '@provia/types';

export class UnbalancedPostingError extends Error {
  constructor(
    public readonly postingId: string,
    public readonly currency: string,
    public readonly netAmount: number,
  ) {
    super(
      `Ledger posting ${postingId} does not balance for ${currency}: ` +
        `net of debits minus credits is ${String(netAmount)}, must be exactly 0. ` +
        `Refusing to write (CLAUDE.md §8).`,
    );
    this.name = 'UnbalancedPostingError';
  }
}

export class DuplicatePostingError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(
      `Idempotency key "${idempotencyKey}" was already used. This posting ` +
        `was not repeated — the original result should be returned to the caller.`,
    );
    this.name = 'DuplicatePostingError';
  }
}

export interface LedgerLine {
  readonly account: LedgerAccount;
  readonly direction: 'debit' | 'credit';
  readonly amount: Money;
  readonly orderId?: string;
  readonly partnerId?: string;
  readonly fundedBy?: BenefitFundedBy;
  /** Each line in a multi-line posting needs its own unique idempotency key. */
  readonly idempotencyKey: string;
}

export interface PostingResult {
  readonly postingId: string;
  readonly lineIds: readonly string[];
  /** True if this call was a no-op because the posting already existed. */
  readonly wasDuplicate: boolean;
}

@Injectable()
export class LedgerService {
  constructor(private readonly pool: Pool) {}

  /**
   * Post a balanced set of ledger lines atomically. All lines succeed or
   * none do. Balance (sum of debits == sum of credits, per currency) is
   * verified in code before any row is written — this is not optional and
   * is not delegated to the caller to get right.
   *
   * Idempotent: if the FIRST line's idempotency key has already been used,
   * this returns the existing posting rather than writing anything new or
   * throwing. This is what makes a retried Paystack webhook, or a network
   * timeout retry from the mobile app, safe (CLAUDE.md §3.6, §9).
   */
  async post(lines: readonly LedgerLine[], client?: PoolClient): Promise<PostingResult> {
    if (lines.length === 0) {
      throw new Error('Cannot post an empty set of ledger lines.');
    }

    this.assertBalanced(lines);

    const db = client ?? (await this.pool.connect());
    const ownsConnection = !client;

    try {
      if (ownsConnection) await db.query('BEGIN');

      const firstLine = lines[0];
      if (!firstLine) throw new Error('Cannot post an empty set of ledger lines.'); // already guarded above, kept for type-narrowing

      // Idempotency check happens INSIDE the transaction, so a concurrent
      // duplicate attempt cannot race past this check before the first one
      // commits — the unique index on idempotency_key is the final backstop
      // if two requests somehow reach here at the same instant.
      const existing = await db.query<{ posting_id: string; id: string }>(
        `select posting_id, id from public.ledger_entries where idempotency_key = $1`,
        [firstLine.idempotencyKey],
      );

      if (existing.rows.length > 0) {
        if (ownsConnection) await db.query('COMMIT');
        const first = existing.rows[0];
        if (!first) throw new Error('Unreachable: existing.rows.length > 0 but rows[0] is undefined.');
        const postingId = first.posting_id;
        const allLines = await db.query<{ id: string }>(
          `select id from public.ledger_entries where posting_id = $1`,
          [postingId],
        );
        return {
          postingId,
          lineIds: allLines.rows.map((r) => r.id),
          wasDuplicate: true,
        };
      }

      const postingId = crypto.randomUUID();
      const lineIds: string[] = [];

      for (const line of lines) {
        const result = await db.query<{ id: string }>(
          `insert into public.ledger_entries
             (posting_id, account, direction, amount, currency, order_id, partner_id, funded_by, idempotency_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id`,
          [
            postingId,
            line.account,
            line.direction,
            line.amount.amount,
            line.amount.currency,
            line.orderId ?? null,
            line.partnerId ?? null,
            line.fundedBy ?? null,
            line.idempotencyKey,
          ],
        );
        const insertedRow = result.rows[0];
        if (!insertedRow) throw new Error('Insert into ledger_entries returned no row — should be impossible.');
        lineIds.push(insertedRow.id);
      }

      if (ownsConnection) await db.query('COMMIT');
      return { postingId, lineIds, wasDuplicate: false };
    } catch (err) {
      if (ownsConnection) await db.query('ROLLBACK');
      // A unique_violation on idempotency_key means we lost a genuine race
      // against a concurrent identical request — treat it the same as the
      // pre-check duplicate path rather than surfacing a raw DB error.
      if (isUniqueViolation(err)) {
        return await this.post(lines, undefined); // re-resolve via the duplicate path above
      }
      throw err;
    } finally {
      if (ownsConnection) db.release();
    }
  }

  /**
   * Balance is verified per currency: sum(debits) must equal sum(credits).
   * This throws BEFORE touching the database — an unbalanced posting never
   * reaches SQL, let alone a partially-written state (CLAUDE.md §8).
   */
  private assertBalanced(lines: readonly LedgerLine[]): void {
    const byCurrency = new Map<string, number>();
    for (const line of lines) {
      const sign = line.direction === 'debit' ? 1 : -1;
      const cur = line.amount.currency;
      byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + sign * line.amount.amount);
    }
    for (const [currency, net] of byCurrency) {
      if (net !== 0) {
        // postingId doesn't exist yet at this point — use a placeholder that
        // still tells the operator which idempotency keys were involved.
        const keys = lines.map((l) => l.idempotencyKey).join(',');
        throw new UnbalancedPostingError(keys, currency, net);
      }
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
