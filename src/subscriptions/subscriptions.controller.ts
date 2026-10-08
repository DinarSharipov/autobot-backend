import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { requirePrincipalUserId } from '../common/http/request-contracts.js';
import { EntitlementService } from './entitlement.service.js';
import { UsageService, type UsageSummaryView } from './usage.service.js';

@ApiTags('Subscription')
@UseGuards(AnyAuthenticatedGuard)
@Controller({ version: '1' })
export class SubscriptionsController {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
  ) {}

  @Get('subscription')
  @ApiOperation({ summary: 'Get the effective plan and entitlements' })
  @ApiOkResponse({ description: 'Effective subscription and entitlements.' })
  async subscription(@CurrentPrincipal() principal: AuthPrincipal | undefined) {
    const effective = await this.entitlements.resolve(requirePrincipalUserId(principal));
    return {
      data: {
        subscriptionId: effective.subscriptionId,
        planCode: effective.planCode,
        planName: effective.planName,
        status: effective.status,
        startsAt: effective.startsAt?.toISOString() ?? null,
        endsAt: effective.endsAt?.toISOString() ?? null,
        entitlements: effective.entitlements,
      },
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage for the current quota period' })
  @ApiOkResponse({ description: 'Current quota-period usage.' })
  async currentUsage(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
  ): Promise<{ data: UsageSummaryView }> {
    return { data: await this.usage.summary(requirePrincipalUserId(principal)) };
  }
}
