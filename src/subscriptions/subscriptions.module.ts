import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { EntitlementService } from './entitlement.service.js';
import { PlanProvisioningService } from './plan-provisioning.service.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SubscriptionsController],
  providers: [EntitlementService, PlanProvisioningService, UsageService],
  exports: [EntitlementService, PlanProvisioningService, UsageService],
})
export class SubscriptionsModule {}
