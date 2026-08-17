/**
 * src/api/client.ts
 *
 * CLAUDE.md §3.9 — actor identity always comes from the verified JWT, this
 * client never sends an actor id. Mirrors the customer app's client.ts
 * shape deliberately, plus the two partner-specific real endpoints
 * (GET /orders list, POST /orders/:id/handoff-code/verify) proven against
 * real Postgres tonight.
 */

import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';
import type { HandoffCodeKind, OrderEventType, ServiceId } from '@provia/types';

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

  return fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

export interface OrderProjection {
  readonly orderId: string;
  readonly serviceId: ServiceId;
  readonly milestoneIndex: number;
  readonly milestoneKey: string;
  readonly isComplete: boolean;
}

/**
 * GET /orders — the partner's own assigned orders. No filter parameters
 * exist because none are needed: the server resolves "mine" from the
 * verified JWT, never a client-supplied partner id (CLAUDE.md §3.9).
 */
export async function listMyOrders(): Promise<readonly OrderProjection[]> {
  const response = await authedFetch('/orders');
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as OrderProjection[];
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

/**
 * POST /orders/:id/handoff-code/verify — the real mechanism proven
 * tonight. On a wrong code the server returns 409 with a specific
 * CodeMismatchError message (attempts remaining, stated plainly); on
 * lockout, 423; on no active code, 404. This function does not swallow
 * or reinterpret any of those — the screen calling it reads response.status
 * directly to decide what to show.
 */
export async function verifyHandoffCode(
  orderId: string,
  kind: HandoffCodeKind,
  code: string,
): Promise<TransitionResult> {
  const response = await authedFetch(`/orders/${orderId}/handoff-code/verify`, {
    method: 'POST',
    body: JSON.stringify({ kind, code }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body as TransitionResult;
}
