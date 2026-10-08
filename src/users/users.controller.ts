import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { IdentityService } from './identity.service.js';
import { toUserView, type UserView } from './user.types.js';

@ApiTags('Users')
@Controller({ path: 'me', version: '1' })
export class UsersController {
  constructor(private readonly identities: IdentityService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOperation({ summary: 'Get the current application user' })
  @ApiOkResponse({ description: 'Current canonical user.' })
  async getCurrent(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
  ): Promise<{ data: UserView }> {
    const userId = principal && 'userId' in principal ? principal.userId : undefined;
    if (!userId) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_REQUIRED',
        'Authentication required.',
      );
    }
    const user = await this.identities.findUser(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_REQUIRED',
        'Authentication required.',
      );
    }
    return { data: toUserView(user) };
  }
}
