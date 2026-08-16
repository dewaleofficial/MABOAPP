/**
 * apps/api/src/orders/orders.controller.ts
 *
 * CLAUDE.md §3.9, §6, §9 — the server never trusts a client-supplied
 * price, and here it never trusts a client-supplied identity either. The
 * actor making a transition is always request.userId from the verified
 * JWT (set by AuthGuard), never a field the client puts in the request
 * body. A client CAN say "I am acting as this rider" in a body, but this
 * controller ignores that entirely for who actually gets recorded as the
 * actor on the resulting order_event.
 *
 * This is a thin HTTP shell. All the actual logic — the transaction, the
 * state machine call, the ledger posting — is in OrdersService, already
 * tested against real Postgres in orders.integration.test.ts. This file's
 * job is only: parse the request, enforce who is allowed to call it, map
 * domain errors to HTTP status codes, return a response.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  HttpCode,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  OrdersService,
  OrderNotFoundError,
  BelowMinimumOrderError,
  IllegalTransitionError,
  MissingCodeError,
} from './orders.service';
import type { OrderComposition, OrderEventType, ServiceId } from '@provia/types';

interface TransitionRequestBody {
  readonly type: OrderEventType;
  readonly payload?: Record<string, unknown>;
}

function isTransitionRequestBody(value: unknown): value is TransitionRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['type'] === 'string';
}

interface CreateOrderRequestBody {
  readonly serviceId: ServiceId;
  readonly zoneId: string;
  readonly composition: OrderComposition;
}

function isCreateOrderRequestBody(value: unknown): value is CreateOrderRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['serviceId'] === 'string' &&
    typeof v['zoneId'] === 'string' &&
    typeof v['composition'] === 'object' &&
    v['composition'] !== null
  );
}

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * POST /orders
   *
   * The fix for a real, previously-flagged gap: the pilot's customer app
   * was creating orders via a direct client-side database insert with the
   * price hardcoded to 0, because this endpoint didn't exist. The client
   * sends an OrderComposition — what the customer wants — never a price.
   * OrdersService.createOrder() calls the already-tested computePrice()
   * to derive the real charge server-side (CLAUDE.md §3.9). customerId is
   * always request.userId from the verified JWT, never a client-supplied
   * field, same principle as transition()'s actor id below.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ orderId: string; total: number; currency: string }> {
    if (!isCreateOrderRequestBody(body)) {
      throw new BadRequestException('Request body must include serviceId, zoneId, and composition.');
    }

    try {
      const result = await this.orders.createOrder({
        customerId: req.userId,
        serviceId: body.serviceId,
        zoneId: body.zoneId,
        composition: body.composition,
      });
      return result;
    } catch (err) {
      if (err instanceof BelowMinimumOrderError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * POST /orders/:id/transition
   *
   * The actor is ALWAYS request.userId (from the verified JWT), never
   * anything from the body. actor "kind" (customer vs partner/rider) is
   * inferred server-side from userRole/context, not claimed by the client
   * — a fuller implementation resolves this against the partners table;
   * kept explicit here as 'customer' for the identity the JWT actually
   * proved, with the TODO called out rather than silently assumed.
   */
  @Post(':id/transition')
  @HttpCode(200)
  async transition(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ orderId: string; milestoneIndex: number; milestoneKey: string; isComplete: boolean }> {
    if (!isTransitionRequestBody(body)) {
      throw new BadRequestException('Request body must include a "type" field.');
    }

    try {
      const outcome = await this.orders.transition({
        orderId,
        type: body.type,
        actor: 'customer', // TODO: resolve real actor kind from req.userId against partners table
        actorId: req.userId,
        payload: body.payload,
      });

      return {
        orderId,
        milestoneIndex: outcome.milestoneIndex,
        milestoneKey: outcome.milestoneKey,
        isComplete: outcome.isComplete,
      };
    } catch (err) {
      // Domain errors from the pure, already-tested state machine are
      // mapped to specific HTTP statuses here — the controller's only
      // job in this catch block, nothing about WHETHER the transition
      // was legal is decided here.
      if (err instanceof OrderNotFoundError) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof MissingCodeError) {
        throw new ConflictException(err.message);
      }
      if (err instanceof IllegalTransitionError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * GET /orders/:id
   *
   * Read-only projection. RLS on the orders table (see
   * infra/migrations/0001_foundation.sql) already restricts a row to its
   * own customer/partner even if this handler's own authorization logic
   * had a bug — defence in depth, the same principle as the ledger's
   * database-level immutability trigger backing up the application-level
   * balance check.
   */
  @Get(':id')
  async get(@Param('id') orderId: string): Promise<{
    readonly orderId: string;
    readonly serviceId: ServiceId;
    readonly milestoneIndex: number;
    readonly milestoneKey: string;
    readonly isComplete: boolean;
  }> {
    const order = await this.orders.getOrderProjection(orderId);
    if (!order) throw new NotFoundException(`Order ${orderId} not found.`);
    return order;
  }
}
