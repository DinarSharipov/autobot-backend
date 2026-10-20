import {
  billingResponse,
  packSchema,
  walletSchema,
  ledgerSchema,
  purchaseOrderSchema,
  purchaseOrderResponse,
} from './billing.openapi.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { requireIdempotencyKey, requirePrincipalUserId } from '../common/http/request-contracts.js';
import {
  GenerationPacksListQuery,
  PurchaseOrderCreateDto,
  WalletLedgerQuery,
} from './generation-packs.dto.js';
import { PurchaseService } from './purchase.service.js';
import { WalletService } from './wallet.service.js';

@ApiTags('Generation packs')
@Controller({ version: '1' })
export class GenerationPacksController {
  constructor(
    private readonly wallets: WalletService,
    private readonly purchases: PurchaseService,
  ) {}

  @Get('generation-packs')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'List active prepaid generation packs' })
  @ApiOkResponse({ schema: billingResponse(packSchema, true) })
  async listPacks(@Query() query: GenerationPacksListQuery) {
    return { data: await this.wallets.listPacks(query.creditType) };
  }

  @Get('wallets')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'Get prepaid generation credit balances' })
  @ApiOkResponse({ schema: billingResponse(walletSchema, true) })
  async walletsForUser(@CurrentPrincipal() principal: AuthPrincipal | undefined) {
    return { data: await this.wallets.balances(requirePrincipalUserId(principal)) };
  }

  @Get('wallets/ledger')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'Get prepaid generation credit ledger' })
  @ApiOkResponse({ schema: billingResponse(ledgerSchema, true) })
  async ledger(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Query() query: WalletLedgerQuery,
  ) {
    return {
      data: await this.wallets.ledger(
        requirePrincipalUserId(principal),
        query.creditType,
        query.limit,
      ),
    };
  }

  @Get('purchase-orders')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'List the current user purchase orders' })
  @ApiOkResponse({ schema: billingResponse(purchaseOrderSchema, true) })
  async listOrders(@CurrentPrincipal() principal: AuthPrincipal | undefined) {
    return { data: await this.purchases.list(requirePrincipalUserId(principal)) };
  }

  @Post('purchase-orders')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128 },
  })
  @UseGuards(MutationAuthGuard)
  @ApiOperation({ summary: 'Create a pending prepaid generation pack purchase order' })
  @ApiCreatedResponse({ schema: purchaseOrderResponse })
  async createOrder(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: PurchaseOrderCreateDto,
  ) {
    return {
      data: await this.purchases.create(
        requirePrincipalUserId(principal),
        dto.packCode,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Get('purchase-orders/:orderId')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'Get an owned prepaid generation pack purchase order' })
  @ApiOkResponse({ schema: purchaseOrderResponse })
  async order(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.purchases.get(requirePrincipalUserId(principal), orderId) };
  }
}
