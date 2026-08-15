/**
 * apps/api/src/common/pg.token.ts
 *
 * Why this file exists: LedgerService and OrdersService correctly import
 * `Pool` as a type-only import (`import type { Pool } from 'pg'`) since
 * neither file constructs a Pool itself — good practice, keeps the
 * dependency surface honest.
 *
 * But NestJS's constructor-based dependency injection relies on
 * `emitDecoratorMetadata` capturing the REAL runtime constructor of each
 * parameter via `design:paramtypes`. A type-only import is erased
 * entirely at compile time, so Nest has nothing to match against and
 * fails at startup with "can't resolve dependencies" — not a typo, a
 * genuine incompatibility between two individually-correct practices.
 *
 * The fix: an explicit injection token, used with @Inject(PG_POOL) at
 * each constructor site, and registered against this same token in
 * app.module.ts. This keeps the type-only imports exactly as they were —
 * no behaviour change to yesterday's already-tested services — and
 * doesn't require them to know anything about how Nest wires them.
 */
export const PG_POOL = Symbol('PG_POOL');

/**
 * Same reasoning as PG_POOL, but for a different NestJS quirk: a guard
 * class referenced via @UseGuards(AuthGuard) is ALWAYS resolved through
 * its own constructor DI, even if a custom factory provider is registered
 * under that same class token elsewhere. A constructor parameter typed as
 * a raw `string` can never be autowired by type (primitives carry no
 * distinguishing runtime identity for Nest to match against), so this
 * token exists purely to give that string a resolvable identity.
 */
export const SUPABASE_JWT_SECRET = Symbol('SUPABASE_JWT_SECRET');

/**
 * Same root cause as PG_POOL and SUPABASE_JWT_SECRET, found a third time:
 * NestJS CONTROLLERS (registered in a module's `controllers` array) are,
 * like guards, always instantiated through their own constructor DI —
 * a custom factory provider registered under the controller's class token
 * is silently ignored for this purpose. PaystackController's constructor
 * takes a raw string and an interface-typed object, neither of which
 * carries a distinguishing runtime type Nest can autowire by itself.
 */
export const PAYSTACK_WEBHOOK_SECRET = Symbol('PAYSTACK_WEBHOOK_SECRET');
export const PAYSTACK_VERIFY_CLIENT = Symbol('PAYSTACK_VERIFY_CLIENT');
