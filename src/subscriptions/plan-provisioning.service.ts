import { Injectable, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { INITIAL_PLANS } from './entitlement.types.js';

@Injectable()
export class PlanProvisioningService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.provision();
  }

  async provision(): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const defaultPlan = INITIAL_PLANS.find((plan) => plan.isDefault);
      if (!defaultPlan) throw new Error('Exactly one initial default plan is required');

      await transaction.subscriptionPlan.updateMany({ data: { isDefault: false } });
      for (const plan of INITIAL_PLANS) {
        await transaction.subscriptionPlan.upsert({
          where: { code: plan.code },
          create: {
            ...plan,
            entitlements: plan.entitlements,
          },
          update: {
            name: plan.name,
            entitlements: plan.entitlements,
            isDefault: plan.isDefault,
            isActive: true,
          },
        });
      }
    });
  }
}
