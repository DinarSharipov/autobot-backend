import { HttpStatus, Injectable } from '@nestjs/common';

import { type UsageEntryKind, type UsageMetric } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { EntitlementService } from './entitlement.service.js';

export type UsageItemView = {
  metric: UsageMetric;
  committed: number;
  reserved: number;
  limit: number | null;
};

export type UsageSummaryView = {
  periodStart: string;
  periodEnd: string;
  items: UsageItemView[];
};

const METRICS: UsageMetric[] = ['TEXT_GENERATION', 'IMAGE_GENERATION', 'MODERATION_REVISION'];

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  period(at = new Date()): { start: Date; end: Date } {
    return {
      start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
      end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
    };
  }

  async summary(userId: string, at = new Date()): Promise<UsageSummaryView> {
    const period = this.period(at);
    const [effective, counters] = await Promise.all([
      this.entitlements.resolve(userId),
      this.prisma.usageCounter.findMany({ where: { userId, periodStart: period.start } }),
    ]);
    const byMetric = new Map(counters.map((counter) => [counter.metric, counter]));
    return {
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      items: METRICS.map((metric) => ({
        metric,
        committed: byMetric.get(metric)?.committed ?? 0,
        reserved: byMetric.get(metric)?.reserved ?? 0,
        limit: this.entitlements.usageLimit(effective.entitlements, metric),
      })),
    };
  }

  reserve(input: UsageMutation): Promise<UsageItemView> {
    return this.mutate({ ...input, kind: 'RESERVE' });
  }

  commit(input: UsageMutation): Promise<UsageItemView> {
    return this.mutate({ ...input, kind: 'COMMIT' });
  }

  release(input: UsageMutation): Promise<UsageItemView> {
    return this.mutate({ ...input, kind: 'RELEASE' });
  }

  private async mutate(input: UsageMutation & { kind: UsageEntryKind }): Promise<UsageItemView> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_USAGE_AMOUNT',
        'Usage amount must be a positive integer.',
      );
    }

    return serializableTransaction(this.prisma, async (transaction) => {
      const period = this.period(input.at);
      const effective = await this.entitlements.resolve(input.userId, transaction);
      if (input.kind === 'RESERVE') {
        this.entitlements.assertMetricEnabled(effective.entitlements, input.metric);
      }
      const limit = this.entitlements.usageLimit(effective.entitlements, input.metric);
      const counter = await transaction.usageCounter.upsert({
        where: {
          userId_metric_periodStart: {
            userId: input.userId,
            metric: input.metric,
            periodStart: period.start,
          },
        },
        create: {
          userId: input.userId,
          metric: input.metric,
          periodStart: period.start,
          periodEnd: period.end,
        },
        update: {},
      });

      const existing = await transaction.usageLedgerEntry.findUnique({
        where: {
          counterId_operationKey: { counterId: counter.id, operationKey: input.operationKey },
        },
      });
      if (existing) {
        if (existing.kind !== input.kind || existing.amount !== input.amount) {
          throw new ApiHttpException(
            HttpStatus.CONFLICT,
            'USAGE_OPERATION_KEY_REUSED',
            'The usage operation key was reused with different parameters.',
          );
        }
        return this.item(counter, limit);
      }

      const changes = this.changes(counter, input.kind, input.amount, limit);
      const updated = await transaction.usageCounter.update({
        where: { id: counter.id },
        data: {
          reserved: { increment: changes.reserved },
          committed: { increment: changes.committed },
          version: { increment: 1 },
        },
      });
      await transaction.usageLedgerEntry.create({
        data: {
          counterId: counter.id,
          kind: input.kind,
          amount: input.amount,
          operationKey: input.operationKey,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      return this.item(updated, limit);
    });
  }

  private changes(
    counter: { reserved: number; committed: number },
    kind: UsageEntryKind,
    amount: number,
    limit: number | null,
  ): { reserved: number; committed: number } {
    if (kind === 'RESERVE') {
      if (limit !== null && counter.reserved + counter.committed + amount > limit) {
        throw new ApiHttpException(
          HttpStatus.FORBIDDEN,
          'USAGE_LIMIT_REACHED',
          'The current plan usage limit was reached.',
          { limit, committed: counter.committed, reserved: counter.reserved },
        );
      }
      return { reserved: amount, committed: 0 };
    }

    if (kind === 'COMMIT' || kind === 'RELEASE') {
      if (counter.reserved < amount) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'USAGE_RESERVATION_NOT_FOUND',
          'There is not enough reserved usage for this operation.',
        );
      }
      return {
        reserved: -amount,
        committed: kind === 'COMMIT' ? amount : 0,
      };
    }

    throw new ApiHttpException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'UNSUPPORTED_USAGE_OPERATION',
      'The usage operation is unsupported.',
    );
  }

  private item(
    counter: { metric: UsageMetric; committed: number; reserved: number },
    limit: number | null,
  ): UsageItemView {
    return {
      metric: counter.metric,
      committed: counter.committed,
      reserved: counter.reserved,
      limit,
    };
  }
}

export type UsageMutation = {
  userId: string;
  metric: UsageMetric;
  amount: number;
  operationKey: string;
  metadata?: {
    publicationId?: string;
    aiRequestId?: string;
  };
  at?: Date;
};
