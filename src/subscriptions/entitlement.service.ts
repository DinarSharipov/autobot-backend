import { HttpStatus, Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { entitlementSchema, type Entitlements } from './entitlement.types.js';

type DatabaseClient = PrismaService | Prisma.TransactionClient;

export type EffectiveSubscription = {
  subscriptionId: string | null;
  planCode: string;
  planName: string;
  status: 'TRIALING' | 'ACTIVE';
  startsAt: Date | null;
  endsAt: Date | null;
  entitlements: Entitlements;
};

@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    userId: string,
    database: DatabaseClient = this.prisma,
  ): Promise<EffectiveSubscription> {
    const now = new Date();
    const subscription = await database.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        plan: { isActive: true },
      },
      include: { plan: true },
      orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (subscription) {
      return {
        subscriptionId: subscription.id,
        planCode: subscription.plan.code,
        planName: subscription.plan.name,
        status: subscription.status as 'TRIALING' | 'ACTIVE',
        startsAt: subscription.startsAt,
        endsAt: subscription.endsAt,
        entitlements: this.parse(subscription.plan.entitlements),
      };
    }

    const plan = await database.subscriptionPlan.findFirst({
      where: { isDefault: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!plan) {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'DEFAULT_PLAN_UNAVAILABLE',
        'The default subscription plan is unavailable.',
      );
    }
    return {
      subscriptionId: null,
      planCode: plan.code,
      planName: plan.name,
      status: 'ACTIVE',
      startsAt: null,
      endsAt: null,
      entitlements: this.parse(plan.entitlements),
    };
  }

  async assertChannelCapacity(userId: string, database: DatabaseClient): Promise<void> {
    const effective = await this.resolve(userId, database);
    const count = await database.channel.count({ where: { userId, status: { not: 'ARCHIVED' } } });
    this.assertBelow(count, effective.entitlements.channelLimit, 'CHANNEL_LIMIT_REACHED');
  }

  async assertTopicCapacity(userId: string, database: DatabaseClient): Promise<void> {
    const effective = await this.resolve(userId, database);
    const count = await database.topic.count({ where: { userId, status: { not: 'ARCHIVED' } } });
    this.assertBelow(count, effective.entitlements.topicLimit, 'TOPIC_LIMIT_REACHED');
  }

  usageLimit(entitlements: Entitlements, metric: string): number | null {
    const limits: Record<string, number | null> = {
      TEXT_GENERATION: entitlements.textGenerationMonthly,
      IMAGE_GENERATION: entitlements.imageGenerationMonthly,
      MODERATION_REVISION: entitlements.moderationRevisionMonthly,
    };
    return limits[metric] ?? 0;
  }

  assertMetricEnabled(entitlements: Entitlements, metric: string): void {
    if (metric === 'IMAGE_GENERATION' && !entitlements.imageGenerationEnabled) {
      throw new ApiHttpException(
        HttpStatus.FORBIDDEN,
        'IMAGE_GENERATION_NOT_INCLUDED',
        'Image generation is not included in the current plan.',
      );
    }
    if (metric === 'MODERATION_REVISION' && !entitlements.moderationEnabled) {
      throw new ApiHttpException(
        HttpStatus.FORBIDDEN,
        'MODERATION_NOT_INCLUDED',
        'Moderation is not included in the current plan.',
      );
    }
  }

  private parse(value: Prisma.JsonValue): Entitlements {
    const result = entitlementSchema.safeParse(value);
    if (!result.success) throw new Error('Subscription plan entitlements are invalid');
    return result.data;
  }

  private assertBelow(current: number, limit: number | null, code: string): void {
    if (limit !== null && current >= limit) {
      throw new ApiHttpException(
        HttpStatus.FORBIDDEN,
        code,
        'The current plan limit was reached.',
        {
          limit,
          current,
        },
      );
    }
  }
}
