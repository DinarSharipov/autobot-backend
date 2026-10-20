import {
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import { requireIdempotencyKey, requirePrincipalUserId } from '../common/http/request-contracts.js';
import { PrepaidTextService } from './prepaid-text.service.js';
import { billingResponse, textCostSchema, textPublicationSchema } from './billing.openapi.js';

@ApiTags('Billing')
@Controller({ path: 'publications', version: '1' })
@UseGuards(MutationAuthGuard)
export class PrepaidTextController {
  constructor(private readonly text: PrepaidTextService) {}

  @Post(':publicationId/generation-cost-preview')
  @HttpCode(200)
  @ApiOkResponse({ schema: billingResponse(textCostSchema) })
  async preview(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) publicationId: string,
  ) {
    return { data: await this.text.preview(requirePrincipalUserId(principal), publicationId) };
  }

  @Post(':publicationId/generation/resume')
  @HttpCode(202)
  @ApiAcceptedResponse({ schema: billingResponse(textPublicationSchema) })
  async resume(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('publicationId', ParseUUIDPipe) publicationId: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.text.resume(
        requirePrincipalUserId(principal),
        publicationId,
        requireIdempotencyKey(key),
      ),
    };
  }
}
