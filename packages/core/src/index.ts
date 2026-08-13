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
