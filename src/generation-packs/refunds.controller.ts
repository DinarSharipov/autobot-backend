import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import { requirePrincipalUserId } from '../common/http/request-contracts.js';
import { billingResponse, refundSchema, purchaseOrderResponse } from './billing.openapi.js';
import { RefundsService } from './refunds.service.js';

@ApiTags('Generation packs')
@Controller({ version: '1', path: 'purchase-orders' })
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get(':orderId/refunds')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'List the latest 100 verified refund states for an owned order' })
  @ApiOkResponse({ schema: billingResponse(refundSchema, true) })
  async list(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.refunds.list(requirePrincipalUserId(principal), orderId) };
  }

  @Post(':orderId/refunds/check')
  @UseGuards(MutationAuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Discover and verify existing provider refunds; never initiate a money transfer',
  })
  @ApiOkResponse({ schema: purchaseOrderResponse })
  async check(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.refunds.check(requirePrincipalUserId(principal), orderId) };
  }
}
