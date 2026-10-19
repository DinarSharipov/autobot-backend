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
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

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
@UseGuards(AnyAuthenticatedGuard)
@Controller({ version: '1' })
export class GenerationPacksController {
  constructor(
    private readonly wallets: WalletService,
    private readonly purchases: PurchaseService,
  ) {}

  @Get('generation-packs')
  @ApiOperation({ summary: 'List active prepaid generation packs' })
  @ApiOkResponse({ description: 'Active server-controlled generation pack catalogue.' })
  async listPacks(@Query() query: GenerationPacksListQuery) {
    return { data: await this.wallets.listPacks(query.creditType) };
  }

  @Get('wallets')
  @ApiOperation({ summary: 'Get prepaid generation credit balances' })
  @ApiOkResponse({ description: 'Balances for text and image credits.' })
  async walletsForUser(@CurrentPrincipal() principal: AuthPrincipal | undefined) {
    return { data: await this.wallets.balances(requirePrincipalUserId(principal)) };
  }

  @Get('wallets/ledger')
  @ApiOperation({ summary: 'Get prepaid generation credit ledger' })
  @ApiOkResponse({ description: 'Append-only credit ledger entries.' })
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
  @ApiOperation({ summary: 'List the current user purchase orders' })
  @ApiOkResponse({ description: 'Purchase order history, including pending payment orders.' })
  async listOrders(@CurrentPrincipal() principal: AuthPrincipal | undefined) {
    return { data: await this.purchases.list(requirePrincipalUserId(principal)) };
  }

  @Post('purchase-orders')
  @UseGuards(MutationAuthGuard)
  @ApiOperation({ summary: 'Create a pending prepaid generation pack purchase order' })
  @ApiCreatedResponse({ description: 'Order with immutable pack and price snapshot.' })
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
  @ApiOperation({ summary: 'Get an owned prepaid generation pack purchase order' })
  @ApiOkResponse({ description: 'A redirect never implies payment completion.' })
  async order(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return { data: await this.purchases.get(requirePrincipalUserId(principal), orderId) };
  }
}
