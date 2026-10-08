import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { IdentityService } from '../users/identity.service.js';
import { toUserView, type UserView } from '../users/user.types.js';
import { AuthRateLimitService } from './auth-rate-limit.service.js';
import { TelegramLoginCallbackQuery, TelegramLoginStartQuery } from './auth.dto.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from './session.service.js';
import { TelegramAuthFlowService } from './telegram-auth-flow.service.js';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly flow: TelegramAuthFlowService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
  ) {}

  @Get('telegram/start')
  @ApiOperation({ summary: 'Start Telegram OIDC Authorization Code + PKCE login' })
  @ApiFoundResponse({ description: 'Redirect to Telegram authorization endpoint.' })
  async start(
    @Query() query: TelegramLoginStartQuery,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.rateLimit.assertAllowed('oidc-start', request.ip ?? 'unknown');
    const authorizationUrl = await this.flow.start(query.returnTo);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(authorizationUrl.toString());
  }

  @Get('telegram/callback')
  @ApiOperation({ summary: 'Complete Telegram login and establish browser session' })
  @ApiFoundResponse({ description: 'Set session cookie and redirect to Web Admin.' })
  async callback(
    @Query() query: TelegramLoginCallbackQuery,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.rateLimit.assertAllowed('oidc-callback', request.ip ?? 'unknown');
    const completed = await this.flow.complete(query.code, query.state, query.error);
    const user = await this.identities.resolveOidcUser(completed.identity);
    if (user.status !== 'ACTIVE') {
      throw new ApiHttpException(
        HttpStatus.FORBIDDEN,
        'USER_INACTIVE',
        'This user cannot sign in.',
      );
    }
    await this.sessions.create(user.id, request, response);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(completed.returnTo);
  }

  @Get('session')
  @ApiCookieAuth('cookieSession')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: 'Get the current browser session' })
  @ApiOkResponse({ description: 'Active authenticated session.' })
  async session(@Req() request: AuthenticatedRequest): Promise<{
    data: { user: UserView; expiresAt: string };
  }> {
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== 'browser' || !request.sessionExpiresAt) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, 'SESSION_REQUIRED', 'Session required.');
    }
    const user = await this.identities.findUser(principal.userId);
    if (!user) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, 'SESSION_REQUIRED', 'Session required.');
    }
    return {
      data: { user: toUserView(user), expiresAt: request.sessionExpiresAt.toISOString() },
    };
  }

  @Get('csrf')
  @ApiCookieAuth('cookieSession')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: 'Get a session-bound CSRF token' })
  @ApiOkResponse({ description: 'CSRF token.' })
  csrf(@Req() request: Request): { data: { token: string } } {
    return { data: { token: this.sessions.csrfToken(request) } };
  }

  @Post('logout')
  @ApiCookieAuth('cookieSession')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard, CsrfGuard)
  @ApiOperation({ summary: 'Revoke the current browser session' })
  @ApiNoContentResponse({ description: 'Session revoked and cookie cleared.' })
  async logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.sessions.logout(request, response);
    response.status(204).send();
  }
}
