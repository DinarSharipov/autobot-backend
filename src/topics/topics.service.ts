import { HttpStatus, Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { EntitlementService } from '../subscriptions/entitlement.service.js';
import { type TopicView, toTopicView } from './topic.types.js';
import type { TopicCreateDto, TopicListQuery, TopicUpdateDto } from './topics.dto.js';

@Injectable()
export class TopicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(userId: string, query: TopicListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.topic.findMany({
      where: {
        userId,
        status: { not: 'ARCHIVED' },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toTopicView),
      page: { nextCursor: hasMore && last ? encodeCursor(last) : null, hasMore },
    };
  }

  async get(userId: string, topicId: string): Promise<TopicView> {
    const topic = await this.prisma.topic.findFirst({ where: { id: topicId, userId } });
    if (!topic) this.notFound();
    return toTopicView(topic);
  }

  async create(userId: string, dto: TopicCreateDto, idempotencyKey: string): Promise<TopicView> {
    const normalized = {
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      promptTemplate: dto.promptTemplate.trim(),
    };
    if (!normalized.name || !normalized.promptTemplate) this.invalidContent();
    try {
      return await this.idempotency.execute({
        userId,
        operation: 'topics.create',
        key: idempotencyKey,
        requestHash: this.idempotency.digest(normalized),
        handler: async (transaction) => {
          const existing = await transaction.topic.findUnique({
            where: { userId_name: { userId, name: normalized.name } },
          });
          if (existing?.status !== 'ARCHIVED') {
            if (existing) this.nameExists();
          }
          await this.entitlements.assertTopicCapacity(userId, transaction);
          if (existing) {
            const topic = await transaction.topic.update({
              where: { id: existing.id },
              data: {
                ...normalized,
                status: 'ACTIVE',
                archivedAt: null,
                version: { increment: 1 },
              },
            });
            return toTopicView(topic);
          }
          const topic = await transaction.topic.create({ data: { userId, ...normalized } });
          return toTopicView(topic);
        },
      });
    } catch (error) {
      this.mapUnique(error);
    }
  }

  async update(
    userId: string,
    topicId: string,
    version: number,
    dto: TopicUpdateDto,
  ): Promise<TopicView> {
    if (
      dto.name === undefined &&
      dto.description === undefined &&
      dto.promptTemplate === undefined
    ) {
      throw new ApiHttpException(
        HttpStatus.BAD_REQUEST,
        'EMPTY_UPDATE',
        'At least one topic field must be provided.',
      );
    }
    const data: Prisma.TopicUpdateManyMutationInput = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      ...(dto.promptTemplate !== undefined ? { promptTemplate: dto.promptTemplate.trim() } : {}),
      version: { increment: 1 },
    };
    if (data.name === '' || data.promptTemplate === '') this.invalidContent();
    try {
      const result = await this.prisma.topic.updateMany({
        where: { id: topicId, userId, version },
        data,
      });
      if (result.count === 0) await this.throwMutationMiss(userId, topicId);
      return toTopicView(
        await this.prisma.topic.findFirstOrThrow({ where: { id: topicId, userId } }),
      );
    } catch (error) {
      this.mapUnique(error);
    }
  }

  async archive(userId: string, topicId: string, version: number): Promise<void> {
    const result = await this.prisma.topic.updateMany({
      where: { id: topicId, userId, version },
      data: { status: 'ARCHIVED', archivedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) await this.throwMutationMiss(userId, topicId);
  }

  private async throwMutationMiss(userId: string, topicId: string): Promise<never> {
    const existing = await this.prisma.topic.findFirst({ where: { id: topicId, userId } });
    if (!existing) this.notFound();
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'STALE_RESOURCE_VERSION',
      'The resource version is stale.',
      { currentVersion: existing.version },
    );
  }

  private mapUnique(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      this.nameExists();
    }
    throw error;
  }

  private invalidContent(): never {
    throw new ApiHttpException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'INVALID_TOPIC_CONTENT',
      'Topic name and prompt template cannot be blank.',
    );
  }

  private nameExists(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'TOPIC_NAME_ALREADY_EXISTS',
      'A topic with this name already exists.',
    );
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, 'TOPIC_NOT_FOUND', 'Topic not found.');
  }
}
