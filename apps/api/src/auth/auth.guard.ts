/**
 * apps/api/src/auth/auth.guard.ts
 *
 * CLAUDE.md §9 — this decides who is allowed to call an endpoint at all,
 * before any handler logic (including the money-path services from
 * yesterday) ever runs. Get this wrong and every RLS policy, every ledger
 * balance check, every idempotency key downstream is protecting a system
 * that let the wrong person in the front door.
 *
 * Supabase's local CLI defaults to ES256 (asymmetric, published via a
 * JWKS endpoint) for session tokens as of v2.71.1+ — confirmed empirically
 * against this project's local instance. Supabase has stated no plan to
 * add an opt-out back to HS256 (github.com/supabase/cli#4726, closed
 * 2026-05-14: "legacy HS256 is deprecated"). A Supabase project created
 * or key-migrated before that cutover can still issue HS256-signed
 * session tokens (shared-secret, no JWKS entry), so this guard verifies
 * BOTH:
 *
 *   - ES256, against the project's published JWKS (fetched once, cached
 *     in-memory by jose's createRemoteJWKSet — see the constructor)
 *   - HS256, against the legacy shared SUPABASE_JWT_SECRET
 *
 * Which path runs is decided by reading the token's OWN declared `alg`
 * header (jose's decodeProtectedHeader — reads the header only, verifies
 * nothing). This is deliberately NOT "try ES256, catch any failure, retry
 * HS256": a broad catch-and-retry would let a malformed or tampered ES256
 * token get a second, weaker attempt under HS256. Branching on the
 * declared alg means every token gets exactly one verification path,
 * matching exactly one algorithm — no fallback-through-failure.
 *
 * Whichever path succeeds, the `sub` claim becomes `request.userId`, which
 * is what every downstream handler treats as `auth.uid()` — the same
 * identity RLS itself checks, so the API layer and the database layer
 * agree on who is making the request.
 *
 * HUMAN REVIEW REQUIRED on any change to this file (CLAUDE.md §9, §18).
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { SUPABASE_JWKS_URL, SUPABASE_JWT_SECRET } from '../common/pg.token';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userRole: 'authenticated' | 'service_role';
}

export class InvalidTokenError extends UnauthorizedException {
  constructor(reason: string) {
    super(`Invalid or expired session token: ${reason}`);
  }
}

interface SupabaseJwtPayload {
  sub: string; // the user's auth.uid()
  role?: string;
  exp: number;
  aud?: string;
}

function isSupabaseJwtPayload(value: unknown): value is SupabaseJwtPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['sub'] === 'string' && typeof v['exp'] === 'number';
}

@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * Built once, here in the constructor — AuthGuard is a default-scope
   * (singleton) Nest provider (see app.module.ts: no Scope.REQUEST,
   * no request-scoped dependencies), so Nest constructs exactly one
   * instance for the process's whole lifetime. That's what makes this a
   * real cache and not just a per-request wrapper: the first request that
   * needs a key triggers jose's actual HTTP fetch to the JWKS endpoint;
   * every later request with a known kid is served from memory. Cache
   * refresh on an unknown kid (rotation) and refetch throttling on repeat
   * misses (cooldownDuration, default 30s) are both handled internally by
   * this function — not reimplemented here.
   */
  private readonly jwks: JWTVerifyGetKey;
  private readonly hs256Secret: Uint8Array;

  constructor(
    @Inject(SUPABASE_JWKS_URL) jwksUrl: string,
    @Inject(SUPABASE_JWT_SECRET) jwtSecret: string,
  ) {
    if (!jwtSecret || jwtSecret.length < 16) {
      // A short or empty secret is not a config typo to shrug off — it is
      // one of two controls standing between "logged in" and "not". Fail
      // loudly at construction time, not silently at the first request.
      throw new Error(
        'AuthGuard constructed with a missing or suspiciously short JWT secret. Refusing to start.',
      );
    }
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    this.hs256Secret = new TextEncoder().encode(jwtSecret);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new InvalidTokenError('missing Authorization: Bearer <token> header');
    }
    const token = header.slice('Bearer '.length);

    let alg: string | undefined;
    try {
      // Reads the JOSE header only — verifies nothing. Used purely to
      // pick which verification path below actually runs.
      ({ alg } = decodeProtectedHeader(token));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown header decoding failure';
      throw new InvalidTokenError(`malformed token header: ${message}`);
    }

    let payload: unknown;
    try {
      // jwtVerify checks the signature AND the expiry for either
      // algorithm. A token whose signature does not match, or whose exp
      // has passed, throws here — it never reaches the
      // isSupabaseJwtPayload check below.
      if (alg === 'ES256') {
        ({ payload } = await jwtVerify(token, this.jwks, { algorithms: ['ES256'] }));
      } else if (alg === 'HS256') {
        ({ payload } = await jwtVerify(token, this.hs256Secret, { algorithms: ['HS256'] }));
      } else {
        throw new Error(`unsupported token algorithm: ${String(alg)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown verification failure';
      throw new InvalidTokenError(message);
    }

    if (!isSupabaseJwtPayload(payload)) {
      throw new InvalidTokenError('token payload does not match the expected shape');
    }

    request.userId = payload.sub;
    request.userRole = payload.role === 'service_role' ? 'service_role' : 'authenticated';

    return true;
  }
}
