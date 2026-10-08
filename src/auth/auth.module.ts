import { Module } from '@nestjs/common';

import { UsersController } from '../users/users.controller.js';
import { UsersModule } from '../users/users.module.js';
import { AllowedReturnUrlService } from './allowed-return-url.service.js';
import { AnyAuthenticatedGuard } from './any-authenticated.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthRateLimitService } from './auth-rate-limit.service.js';
import { BotRequestSignatureService } from './bot-request-signature.service.js';
import { BotServiceGuard } from './bot-service.guard.js';
import { BotUserGuard } from './bot-user.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { InternalTelegramUsersController } from './internal-telegram-users.controller.js';
import { MutationAuthGuard } from './mutation-auth.guard.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from './session.service.js';
import { TelegramAuthFlowService } from './telegram-auth-flow.service.js';
import { TelegramOidcClient, TelegramOidcHttpClient } from './telegram-oidc.client.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, InternalTelegramUsersController, UsersController],
  providers: [
    AllowedReturnUrlService,
    AnyAuthenticatedGuard,
    AuthRateLimitService,
    BotRequestSignatureService,
    BotServiceGuard,
    BotUserGuard,
    CsrfGuard,
    MutationAuthGuard,
    SessionAuthGuard,
    SessionService,
    TelegramAuthFlowService,
    { provide: TelegramOidcClient, useClass: TelegramOidcHttpClient },
  ],
  exports: [
    AnyAuthenticatedGuard,
    BotServiceGuard,
    BotUserGuard,
    CsrfGuard,
    MutationAuthGuard,
    SessionAuthGuard,
  ],
})
export class AuthModule {}
