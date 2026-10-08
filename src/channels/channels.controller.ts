import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import {
  parseIfMatch,
  requireIdempotencyKey,
  requirePrincipalUserId,
} from '../common/http/request-contracts.js';
import type { ChannelView } from './channel.types.js';
import { ChannelCreateDto, ChannelListQuery, ChannelUpdateDto } from './channels.dto.js';
import { ChannelsService } from './channels.service.js';

@ApiTags('Channels')
@Controller({ path: 'channels', version: '1' })
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned channel page.' })
  list(@CurrentPrincipal() principal: AuthPrincipal | undefined, @Query() query: ChannelListQuery) {
    return this.channels.list(requirePrincipalUserId(principal), query);
  }

  @Get(':channelId')
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned channel.' })
  async get(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<{ data: ChannelView }> {
    return { data: await this.channels.get(requirePrincipalUserId(principal), channelId) };
  }

  @Post()
  @UseGuards(MutationAuthGuard)
  @ApiCreatedResponse({ description: 'Linked and verified channel.' })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ChannelCreateDto,
  ): Promise<{ data: ChannelView }> {
    return {
      data: await this.channels.create(
        requirePrincipalUserId(principal),
        dto,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Patch(':channelId')
  @UseGuards(MutationAuthGuard)
  async update(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: ChannelUpdateDto,
  ): Promise<{ data: ChannelView }> {
    return {
      data: await this.channels.update(
        requirePrincipalUserId(principal),
        channelId,
        parseIfMatch(ifMatch),
        dto,
      ),
    };
  }

  @Delete(':channelId')
  @HttpCode(204)
  @UseGuards(MutationAuthGuard)
  @ApiNoContentResponse({ description: 'Channel archived.' })
  async archive(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.channels.archive(
      requirePrincipalUserId(principal),
      channelId,
      parseIfMatch(ifMatch),
    );
  }

  @Post(':channelId/verify')
  @UseGuards(MutationAuthGuard)
  async verify(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<{ data: ChannelView }> {
    return {
      data: await this.channels.verify(
        requirePrincipalUserId(principal),
        channelId,
        requireIdempotencyKey(key),
      ),
    };
  }
}
