import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import {
  parseIfMatch,
  requireIdempotencyKey,
  requirePrincipalUserId,
} from '../common/http/request-contracts.js';
import { billingResponse } from '../generation-packs/billing.openapi.js';
import { mediaSchema, mediaListSchema, mediaCostSchema } from './publication-media.openapi.js';
import { PublicationMediaService } from './publication-media.service.js';

export class MediaRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  costConfirmationId!: string;
}
export class MediaSelectDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Explicitly retain an image generated for earlier text.',
  })
  @IsOptional()
  @IsBoolean()
  keepOutdated = false;
}
@ApiTags('Publication media')
@Controller({ path: 'publications/:publicationId/media', version: '1' })
export class PublicationMediaController {
  constructor(private readonly media: PublicationMediaService) {}
  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ schema: billingResponse(mediaListSchema) })
  async list(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.media.list(requirePrincipalUserId(principal), id) };
  }
  @Post('cost-preview')
  @HttpCode(200)
  @UseGuards(MutationAuthGuard)
  @ApiOkResponse({ schema: billingResponse(mediaCostSchema) })
  async preview(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.media.preview(requirePrincipalUserId(principal), id) };
  }
  @Post()
  @HttpCode(202)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ schema: billingResponse(mediaSchema) })
  async request(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Headers('if-match') match: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: MediaRequestDto,
  ) {
    return {
      data: await this.media.request(
        requirePrincipalUserId(principal),
        id,
        parseIfMatch(match),
        dto.costConfirmationId,
        requireIdempotencyKey(key),
      ),
    };
  }
  @Post(':mediaId/select')
  @HttpCode(200)
  @UseGuards(MutationAuthGuard)
  @ApiOkResponse({ schema: billingResponse(mediaSchema) })
  async select(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Headers('if-match') match: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: MediaSelectDto,
  ) {
    return {
      data: await this.media.select(
        requirePrincipalUserId(principal),
        id,
        mediaId,
        parseIfMatch(match),
        dto.keepOutdated,
        requireIdempotencyKey(key),
      ),
    };
  }
  @Post(':mediaId/reject')
  @HttpCode(200)
  @UseGuards(MutationAuthGuard)
  @ApiOkResponse({ schema: billingResponse(mediaSchema) })
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Headers('if-match') match: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.media.reject(
        requirePrincipalUserId(principal),
        id,
        mediaId,
        parseIfMatch(match),
        requireIdempotencyKey(key),
      ),
    };
  }
  @Post(':mediaId/resume')
  @HttpCode(202)
  @UseGuards(MutationAuthGuard)
  @ApiAcceptedResponse({ schema: billingResponse(mediaSchema) })
  async resume(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.media.resume(
        requirePrincipalUserId(principal),
        id,
        mediaId,
        requireIdempotencyKey(key),
      ),
    };
  }
}
