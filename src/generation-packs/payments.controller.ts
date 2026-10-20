import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { requirePrincipalUserId } from '../common/http/request-contracts.js';
import { PaymentsService } from './payments.service.js';
import { purchaseOrderResponse } from './billing.openapi.js';

const notification = z.object({
  type: z.literal('notification'),
  event: z.enum(['payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture']),
  object: z.object({ id: z.string().uuid() }),
});

@ApiTags('Generation packs')
@UseGuards(MutationAuthGuard)
@Controller({ version: '1', path: 'purchase-orders' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':orderId/payment')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or recover a test payment for an owned order' })
  @ApiOkResponse({ schema: purchaseOrderResponse })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.payments.create(requirePrincipalUserId(principal), orderId) };
  }

  @Post(':orderId/payment/check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify an owned payment and fulfill succeeded test payments' })
  @ApiOkResponse({ schema: purchaseOrderResponse })
  async check(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.payments.check(requirePrincipalUserId(principal), orderId) };
  }
}

@ApiTags('Payments')
@Controller({ version: '1', path: 'payments/yookassa' })
export class YooKassaWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a notification; verify payment with YooKassa before granting credits',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'event', 'object'],
      properties: {
        type: { type: 'string', enum: ['notification'] },
        event: {
          type: 'string',
          enum: ['payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture'],
        },
        object: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', properties: { received: { type: 'boolean' } } } })
  async webhook(@Body() body: unknown) {
    const parsed = notification.safeParse(body);
    if (!parsed.success)
      throw new ApiHttpException(
        400,
        'INVALID_PAYMENT_NOTIFICATION',
        'Invalid payment notification.',
      );
    return this.payments.webhook(parsed.data.event, parsed.data.object.id);
  }
}
