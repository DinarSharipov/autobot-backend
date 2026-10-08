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
import type { TopicView } from './topic.types.js';
import { TopicCreateDto, TopicListQuery, TopicUpdateDto } from './topics.dto.js';
import { TopicsService } from './topics.service.js';

@ApiTags('Topics')
@Controller({ path: 'topics', version: '1' })
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned topic page.' })
  list(@CurrentPrincipal() principal: AuthPrincipal | undefined, @Query() query: TopicListQuery) {
    return this.topics.list(requirePrincipalUserId(principal), query);
  }

  @Get(':topicId')
  @UseGuards(AnyAuthenticatedGuard)
  async get(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('topicId', ParseUUIDPipe) topicId: string,
  ): Promise<{ data: TopicView }> {
    return { data: await this.topics.get(requirePrincipalUserId(principal), topicId) };
  }

  @Post()
  @UseGuards(MutationAuthGuard)
  @ApiCreatedResponse({ description: 'Created topic.' })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: TopicCreateDto,
  ): Promise<{ data: TopicView }> {
    return {
      data: await this.topics.create(
        requirePrincipalUserId(principal),
        dto,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Patch(':topicId')
  @UseGuards(MutationAuthGuard)
  async update(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('topicId', ParseUUIDPipe) topicId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: TopicUpdateDto,
  ): Promise<{ data: TopicView }> {
    return {
      data: await this.topics.update(
        requirePrincipalUserId(principal),
        topicId,
        parseIfMatch(ifMatch),
        dto,
      ),
    };
  }

  @Delete(':topicId')
  @HttpCode(204)
  @UseGuards(MutationAuthGuard)
  @ApiNoContentResponse({ description: 'Topic archived.' })
  async archive(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('topicId', ParseUUIDPipe) topicId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.topics.archive(requirePrincipalUserId(principal), topicId, parseIfMatch(ifMatch));
  }
}
