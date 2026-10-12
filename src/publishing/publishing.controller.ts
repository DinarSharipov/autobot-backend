import {
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
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import { requireIdempotencyKey, requirePrincipalUserId } from '../common/http/request-contracts.js';
import { PublicationListQuery } from './publishing.dto.js';
import { PublishingService } from './publishing.service.js';

@ApiTags('Publications')
@Controller({ path: 'publications', version: '1' })
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned publication page.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Query() query: PublicationListQuery,
  ) {
    return this.publishing.list(requirePrincipalUserId(principal), query);
  }

  @Get(':publicationId')
  @UseGuards(AnyAuthenticatedGuard)
  async get(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.publishing.get(requirePrincipalUserId(principal), id) };
  }

  @Post(':publicationId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ description: 'Publication retry requested.' })
  async retry(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.publishing.retry(
        requirePrincipalUserId(principal),
        id,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Post(':publicationId/cancel')
  @UseGuards(MutationAuthGuard)
  @ApiOkResponse({ description: 'Publication cancelled.' })
  async cancel(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.publishing.cancel(
        requirePrincipalUserId(principal),
        id,
        requireIdempotencyKey(key),
      ),
    };
  }
}
