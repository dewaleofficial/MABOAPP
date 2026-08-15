/**
 * The service registry.
 *
 * The spine looks services up here. It never branches on a service id.
 * Adding service six means one manifest file and one line in this map.
 */

import type { ServiceId, ServiceModule } from '@provia/types';
import { laundry } from './laundry';
import { courier } from './courier';

const REGISTRY: Partial<Record<ServiceId, ServiceModule>> = {
  laundry,
  courier,
  // carwash     — Wave 2
  // cleaning    — Wave 2
  // marketplace — Wave 2, built last (CLAUDE.md section 2)
};

export const SERVICES = REGISTRY;

export const getService = (id: ServiceId): ServiceModule => {
  const mod = REGISTRY[id];
  if (!mod) {
    throw new Error(
      `Service "${id}" is not registered. Add its manifest to ` +
        `packages/core/src/services and register it here. ` +
        `Do not branch on service id in spine code.`,
    );
  }
  return mod;
};
