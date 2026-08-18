/**
 * @provia/core — the platform spine.
 *
 * Everything exported here is service-agnostic. If you are about to add
 * something only one service needs, it belongs in a service module instead.
 * See CLAUDE.md section 2.
 */

export * as Money from './money';
export { SERVICES, getService } from './services/registry';
export type { ServiceModule } from '@provia/types';

// State machine (CLAUDE.md §6, §10) — the only legal way to derive or
// change order state. Nothing outside this module infers state any other way.
export {
  deriveState,
  attemptTransition,
  getAdvancingEvent,
  projectOrderState,
  IllegalTransitionError,
  MissingCodeError,
} from './engine/stateMachine';
export type { DerivedOrderState, TransitionInput } from './engine/stateMachine';

// Pricing engine (CLAUDE.md §8) — the only place the fixed pricing order
// is allowed to exist. The server computes price here; nothing downstream
// re-derives it.
export { computePrice } from './engine/pricing';
export type {
  PricingInput,
  DetailedPriceBreakdown,
  AppliedEntitlement,
  CommissionRule,
  PromotionCode,
  EntitlementUsageContext,
} from './engine/pricing';
