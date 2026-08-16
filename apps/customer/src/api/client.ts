/**
 * src/api/client.ts
 *
 * CLAUDE.md §3.9 — the server never trusts a client-supplied price or
 * identity. This client reflects that on the way out too: it never sends
 * an actor id, a total, or a milestone index — those are always
 * server-computed. Every authenticated call attaches the real Supabase
 * session token; there is no other identity mechanism in this app.
 */

import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';
import type { OrderComposition, OrderEventType, ServiceId } from '@provia/types';

function apiBaseUrl(): string {
  const url = Constants.expoConfig?.extra?.['apiBaseUrl'] as string | undefined;
  if (!url) throw new Error('Missing app config value: apiBaseUrl.');
  return url;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with ${String(status)}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('No active session. The user must sign in before calling the API.');

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return response;
}

// ─────────────────────────────────────────────────────────────
// Order creation — the same shape OrdersController.create() returns.
// The client sends a composition, never a price; computePrice() derives
// the real total server-side (CLAUDE.md §3.9).
// ─────────────────────────────────────────────────────────────

export interface CreateOrderResult {
  readonly orderId: string;
  readonly total: number;
  readonly currency: string;
}

export async function createOrder(
  serviceId: ServiceId,
  zoneId: string,
  composition: OrderComposition,
): Promise<CreateOrderResult> {
  const response = await authedFetch('/orders', {
    method: 'POST',
    body: JSON.stringify({ serviceId, zoneId, composition }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as CreateOrderResult;
}

// ─────────────────────────────────────────────────────────────
// Order projection — the same shape OrdersController.get() returns.
// Mirrors the server's real response type; not invented independently.
// ─────────────────────────────────────────────────────────────

export interface OrderProjection {
  readonly orderId: string;
  readonly serviceId: ServiceId;
  readonly milestoneIndex: number;
  readonly milestoneKey: string;
  readonly isComplete: boolean;
}

export async function getOrder(orderId: string): Promise<OrderProjection> {
  const response = await authedFetch(`/orders/${orderId}`);
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as OrderProjection;
}

export interface TransitionResult {
  readonly orderId: string;
  readonly milestoneIndex: number;
  readonly milestoneKey: string;
  readonly isComplete: boolean;
}

/**
 * The pilot's mocked-payment order.paid transition still goes through this
 * exact call — there is no separate "fake payment" code path on the
 * client. The mock lives entirely on the server side of the decision
 * (CLAUDE.md's later note on this), so the app behaves identically once
 * Paystack goes live; nothing here needs to change.
 */
export async function transitionOrder(
  orderId: string,
  type: OrderEventType,
  payload?: Record<string, unknown>,
): Promise<TransitionResult> {
  const response = await authedFetch(`/orders/${orderId}/transition`, {
    method: 'POST',
    body: JSON.stringify({ type, payload }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as TransitionResult;
}
