import { HttpStatus, Injectable } from '@nestjs/common';

import { type Prisma, PostStatus, PublicationMode } from '../generated/prisma/client.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { EntitlementService } from '../subscriptions/entitlement.service.js';
import { GenerationFundingService } from '../generation-packs/generation-funding.service.js';
import type {
  PostCreateDto,
  PostListQuery,
  PostUpdateDto,
  PostVersionListQuery,
} from './posts.dto.js';
import {
  type PostView,
  type PublicationView,
  toPostVersionView,
  toPostView,
  toPublicationView,
} from './post.types.js';

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly funding: GenerationFundingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(userId: string, query: PostListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.post.findMany({
      where: {
        userId,
        ...(query.channelId ? { channelId: query.channelId } : {}),
        ...(query.status ? { status: query.status } : { status: { not: PostStatus.ARCHIVED } }),
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
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toPostView),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async get(userId: string, postId: string): Promise<PostView> {
    return toPostView(await this.ownedPost(userId, postId));
  }

  async create(userId: string, dto: PostCreateDto, key: string): Promise<PostView> {
    const data = this.normalized(dto);
    return this.idempotency.execute({
      userId,
      operation: 'posts.create',
      key,
      requestHash: this.idempotency.digest(data),
      handler: async (transaction) => {
        await this.assertDependencies(userId, data, transaction);
        const post = await transaction.post.create({
          data: { userId, ...data, status: PostStatus.ACTIVE },
        });
        await this.audit(transaction, userId, post.id, 'post.created');
        return toPostView(post);
      },
    });
  }

  async update(
    userId: string,
    postId: string,
    version: number,
    dto: PostUpdateDto,
  ): Promise<PostView> {
    if (Object.values(dto).every((value) => value === undefined)) this.emptyUpdate();
    const current = await this.ownedPost(userId, postId);
    if (current.status !== PostStatus.ACTIVE) this.notEditable();
    const data = this.normalized({
      channelId: dto.channelId ?? current.channelId,
      topicId: dto.topicId === undefined ? current.topicId : (dto.topicId ?? null),
      title: dto.title === undefined ? current.title : dto.title,
      prompt: dto.prompt ?? current.prompt,
      generateImage: dto.generateImage ?? current.generateImage,
      publicationMode: dto.publicationMode ?? current.publicationMode,
    });
    await this.assertDependencies(userId, data, this.prisma);
    const result = await this.prisma.post.updateMany({
      where: { id: postId, userId, version, status: PostStatus.ACTIVE },
      data: { ...data, version: { increment: 1 } },
    });
    if (!result.count) await this.throwMutationMiss(userId, postId);
    return toPostView(await this.ownedPost(userId, postId));
  }

  async archive(userId: string, postId: string, version: number): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.post.updateMany({
        where: { id: postId, userId, version, status: PostStatus.ACTIVE },
        data: { status: PostStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } },
      });
      if (!result.count) await this.throwMutationMiss(userId, postId, transaction);
      await this.audit(transaction, userId, postId, 'post.archived');
    });
  }

  async listVersions(userId: string, postId: string, query: PostVersionListQuery) {
    await this.ownedPost(userId, postId);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.postVersion.findMany({
      where: {
        postId,
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
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toPostVersionView),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async createImmediatePublication(
    userId: string,
    postId: string,
    version: number,
    key: string,
  ): Promise<PublicationView> {
    return this.idempotency.execute({
      userId,
      operation: `posts.publish-now:${postId}`,
      key,
      requestHash: this.idempotency.digest({ postId, version }),
      handler: async (transaction) => {
        const post = await transaction.post.findFirst({
          where: { id: postId, userId },
          include: { channel: true, topic: true },
        });
        if (!post) this.notFound();
        if (post.version !== version) this.stale(post.version);
        if (post.status !== PostStatus.ACTIVE) this.notPublishable();
        await this.assertDependencies(userId, post, transaction);
        const publication = await transaction.publication.create({
          data: {
            postId,
            fundingMode: this.funding.isPrepaid ? 'PREPAID' : 'LEGACY',
            idempotencyKey: `${userId}:${key}`,
            scheduledFor: new Date(),
            definition: this.publicationDefinition(post),
          },
        });
        if (publication.fundingMode === 'LEGACY') {
          await this.funding.reserveText(userId, publication.id, transaction, undefined, false);
          if (post.generateImage)
            await this.funding.reserveImage(userId, publication.id, transaction, undefined, false);
        }
        await transaction.outboxEvent.create({
          data: {
            aggregateType: 'Publication',
            aggregateId: publication.id,
            eventType: 'publication.generation.requested.v1',
            payload: { schemaVersion: 1, publicationId: publication.id },
          },
        });
        await this.audit(transaction, userId, publication.id, 'publication.immediate_requested', {
          postId,
        });
        return toPublicationView(publication);
      },
    });
  }

  private normalized(
    input: Pick<
      PostCreateDto,
      'channelId' | 'topicId' | 'title' | 'prompt' | 'generateImage' | 'publicationMode'
    >,
  ) {
    return {
      channelId: input.channelId,
      topicId: input.topicId ?? null,
      title: input.title?.trim() || null,
      prompt: input.prompt.trim(),
      generateImage: input.generateImage,
      publicationMode: input.publicationMode,
    };
  }

  private publicationDefinition(post: {
    prompt: string;
    generateImage: boolean;
    publicationMode: PublicationMode;
    channel: { telegramChatId: bigint };
    topic: { promptTemplate: string } | null;
  }): Prisma.InputJsonValue {
    return {
      prompt: post.prompt,
      generateImage: post.generateImage,
      publicationMode: post.publicationMode,
      telegramChatId: post.channel.telegramChatId.toString(),
      topicPromptTemplate: post.topic?.promptTemplate ?? null,
    };
  }

  private async assertDependencies(
    userId: string,
    input: {
      channelId: string;
      topicId: string | null;
      generateImage: boolean;
      publicationMode: PublicationMode;
    },
    database: PrismaService | Prisma.TransactionClient,
  ): Promise<void> {
    const channel = await database.channel.findFirst({
      where: { id: input.channelId, userId, status: 'ACTIVE' },
    });
    if (!channel)
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'CHANNEL_NOT_ACTIVE',
        'Post channel must be active.',
      );
    if (input.topicId) {
      const topic = await database.topic.findFirst({
        where: { id: input.topicId, userId, status: 'ACTIVE' },
      });
      if (!topic)
        throw new ApiHttpException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'TOPIC_NOT_ACTIVE',
          'Post topic must be active.',
        );
    }
    const effective = await this.entitlements.resolve(userId, database);
    if (input.generateImage)
      this.entitlements.assertMetricEnabled(effective.entitlements, 'IMAGE_GENERATION');
    if (input.publicationMode === PublicationMode.MODERATION)
      this.entitlements.assertMetricEnabled(effective.entitlements, 'MODERATION_REVISION');
  }

  private async ownedPost(userId: string, postId: string) {
    const post = await this.prisma.post.findFirst({ where: { id: postId, userId } });
    if (!post) this.notFound();
    return post;
  }

  private async throwMutationMiss(
    userId: string,
    postId: string,
    database: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<never> {
    const existing = await database.post.findFirst({ where: { id: postId, userId } });
    if (!existing) this.notFound();
    this.stale(existing.version);
  }

  private audit(
    transaction: Prisma.TransactionClient,
    userId: string,
    entityId: string,
    action: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return transaction.auditEvent.create({
      data: {
        userId,
        actorType: 'USER',
        actorId: userId,
        action,
        entityType: 'Post',
        entityId,
        ...(metadata ? { metadata } : {}),
      },
    });
  }

  private emptyUpdate(): never {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'EMPTY_UPDATE',
      'At least one post field must be provided.',
    );
  }
  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, 'POST_NOT_FOUND', 'Post not found.');
  }
  private notEditable(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'POST_NOT_EDITABLE',
      'Only active posts can be updated.',
    );
  }
  private notPublishable(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'POST_NOT_PUBLISHABLE',
      'Only active posts can be published.',
    );
  }
  private stale(currentVersion: number): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'STALE_RESOURCE_VERSION',
      'The resource version is stale.',
      { currentVersion },
    );
  }
}
