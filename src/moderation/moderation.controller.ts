import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiTags } from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import {
  parseIfMatch,
  requireIdempotencyKey,
  requirePrincipalUserId,
} from '../common/http/request-contracts.js';
import { ModerationRevisionDto, ModerationListQuery } from './moderation.dto.js';
import { ModerationService } from './moderation.service.js';

@ApiTags('Moderation')
@Controller({ path: 'moderation', version: '1' })
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  list(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Query() query: ModerationListQuery,
  ) {
    return this.moderation.list(requirePrincipalUserId(principal), query);
  }

  @Post(':moderationRequestId/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ description: 'Moderation approved and publication is ready.' })
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('moderationRequestId', ParseUUIDPipe) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.moderation.approve(
        requirePrincipalUserId(principal),
        requestId,
        parseIfMatch(ifMatch),
        requireIdempotencyKey(key),
      ),
    };
  }

  @Post(':moderationRequestId/revision')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ description: 'Revision requested and a new generation is queued.' })
  async revision(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('moderationRequestId', ParseUUIDPipe) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ModerationRevisionDto,
  ) {
    return {
      data: await this.moderation.requestRevision(
        requirePrincipalUserId(principal),
        requestId,
        parseIfMatch(ifMatch),
        dto.feedback,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Post(':moderationRequestId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MutationAuthGuard)
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('moderationRequestId', ParseUUIDPipe) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.moderation.reject(
        requirePrincipalUserId(principal),
        requestId,
        parseIfMatch(ifMatch),
        requireIdempotencyKey(key),
      ),
    };
  }
}
