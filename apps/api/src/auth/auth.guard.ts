/**
 * apps/api/src/auth/auth.guard.ts
 *
 * CLAUDE.md §9 — this decides who is allowed to call an endpoint at all,
 * before any handler logic (including the money-path services from
 * yesterday) ever runs. Get this wrong and every RLS policy, every ledger
 * balance check, every idempotency key downstream is protecting a system
 * that let the wrong person in the front door.
 *
 * Supabase issues standard JWTs (HS256, signed with the project's JWT
 * secret) on login. This guard verifies that signature — NOT by trusting
 * whatever the client claims about who they are, but by checking the
 * cryptographic signature against the secret only the backend holds. The
 * `sub` claim becomes `request.userId`, which is what every downstream
 * handler treats as `auth.uid()` — the same identity RLS itself checks,
 * so the API layer and the database layer agree on who is making the request.
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
import jwt from 'jsonwebtoken';
import { SUPABASE_JWT_SECRET } from '../common/pg.token';

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
  constructor(@Inject(SUPABASE_JWT_SECRET) private readonly jwtSecret: string) {
    if (!jwtSecret || jwtSecret.length < 16) {
      // A short or empty secret is not a config typo to shrug off — it is
      // the single control standing between "logged in" and "not". Fail
      // loudly at construction time, not silently at the first request.
      throw new Error(
        'AuthGuard constructed with a missing or suspiciously short JWT secret. Refusing to start.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new InvalidTokenError('missing Authorization: Bearer <token> header');
    }
    const token = header.slice('Bearer '.length);

    let decoded: unknown;
    try {
      // jwt.verify checks the signature AND the expiry. A token whose
      // signature does not match, or whose exp has passed, throws here —
      // it never reaches the isSupabaseJwtPayload check below.
      decoded = jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown verification failure';
      throw new InvalidTokenError(message);
    }

    if (!isSupabaseJwtPayload(decoded)) {
      throw new InvalidTokenError('token payload does not match the expected shape');
    }

    request.userId = decoded.sub;
    request.userRole = decoded.role === 'service_role' ? 'service_role' : 'authenticated';

    return true;
  }
}
