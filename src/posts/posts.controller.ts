import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import {
  parseIfMatch,
  requireIdempotencyKey,
  requirePrincipalUserId,
} from '../common/http/request-contracts.js';
import { PostCreateDto, PostListQuery, PostUpdateDto, PostVersionListQuery } from './posts.dto.js';
import { PostsService } from './posts.service.js';

@ApiTags('Posts')
@Controller({ path: 'posts', version: '1' })
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned post page.' })
  list(@CurrentPrincipal() principal: AuthPrincipal | undefined, @Query() query: PostListQuery) {
    return this.posts.list(requirePrincipalUserId(principal), query);
  }

  @Post()
  @UseGuards(MutationAuthGuard)
  @ApiCreatedResponse({ description: 'Created active post definition.' })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: PostCreateDto,
  ) {
    return {
      data: await this.posts.create(
        requirePrincipalUserId(principal),
        dto,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Get(':postId')
  @UseGuards(AnyAuthenticatedGuard)
  async get(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
  ) {
    return { data: await this.posts.get(requirePrincipalUserId(principal), postId) };
  }

  @Patch(':postId')
  @UseGuards(MutationAuthGuard)
  async update(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: PostUpdateDto,
  ) {
    return {
      data: await this.posts.update(
        requirePrincipalUserId(principal),
        postId,
        parseIfMatch(ifMatch),
        dto,
      ),
    };
  }

  @Delete(':postId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MutationAuthGuard)
  @ApiNoContentResponse({ description: 'Post archived.' })
  async archive(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.posts.archive(requirePrincipalUserId(principal), postId, parseIfMatch(ifMatch));
  }

  @Get(':postId/versions')
  @UseGuards(AnyAuthenticatedGuard)
  listVersions(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query() query: PostVersionListQuery,
  ) {
    return this.posts.listVersions(requirePrincipalUserId(principal), postId, query);
  }

  @Post(':postId/publications')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ description: 'Immediate publication occurrence created.' })
  async publishNow(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.posts.createImmediatePublication(
        requirePrincipalUserId(principal),
        postId,
        parseIfMatch(ifMatch),
        requireIdempotencyKey(key),
      ),
    };
  }
}
