import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { IdentityService } from '../users/identity.service.js';
import { toUserView, type UserView } from '../users/user.types.js';
import { TelegramProfileInput } from './auth.dto.js';
import { BotServiceGuard } from './bot-service.guard.js';

@ApiTags('Internal')
@Controller({ path: 'internal/telegram-users', version: '1' })
export class InternalTelegramUsersController {
  constructor(private readonly identities: IdentityService) {}

  @Post('resolve')
  @ApiSecurity('botSignature')
  @HttpCode(200)
  @UseGuards(BotServiceGuard)
  @ApiOperation({ summary: 'Resolve or onboard the authenticated bot caller Telegram user' })
  @ApiOkResponse({ description: 'Canonical application user.' })
  async resolve(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Body() profile: TelegramProfileInput,
  ): Promise<{ data: UserView }> {
    if (!principal || principal.kind !== 'bot-service') {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'BOT_AUTH_REQUIRED',
        'Authenticated bot service access is required.',
      );
    }

    const user = await this.identities.resolveBotUser({
      telegramUserId: principal.telegramUserId,
      ...profile,
    });
    return { data: toUserView(user) };
  }
}
