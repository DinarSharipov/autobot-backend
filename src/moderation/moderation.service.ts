import { HttpStatus, Injectable } from '@nestjs/common';

import { type Prisma, PostVersionStatus, PublicationStatus } from '../generated/prisma/client.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { UsageService } from '../subscriptions/usage.service.js';
import {
  PublicationMediaService,
  mediaImageEnabled,
} from '../publishing/publication-media.service.js';
import { PrepaidTextService } from '../generation-packs/prepaid-text.service.js';
import { GenerationFundingService } from '../generation-packs/generation-funding.service.js';
import type { ModerationListQuery } from './moderation.dto.js';
import { toModerationRequestView } from './moderation.types.js';
import { toPublicationView, type PublicationView } from '../posts/post.types.js';

const moderationInclude = { postVersion: true, publication: { include: { post: true } } } as const;

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly usage: UsageService,
    private readonly funding: GenerationFundingService,
    private readonly prepaid: PrepaidTextService,
    private readonly media: PublicationMediaService,
  ) {}

  async list(userId: string, query: ModerationListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.moderationRequest.findMany({
      where: {
        post: { userId },
        ...(query.status ? { status: query.status } : { status: 'PENDING' }),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: moderationInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toModerationRequestView),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  approve(
    userId: string,
    requestId: string,
    version: number,
    key: string,
  ): Promise<PublicationView> {
    return this.idempotency.execute({
      userId,
      operation: `moderation.approve:${requestId}`,
      key,
      requestHash: this.idempotency.digest({ requestId, version }),
      handler: async (transaction) => {
        const request = await this.pendingRequest(transaction, userId, requestId, version);
        if (
          request.publication.fundingMode === 'PREPAID' &&
          mediaImageEnabled(request.publication)
        ) {
          const selected = request.publication.selectedMediaId
            ? await transaction.publicationMedia.findUnique({
                where: { id: request.publication.selectedMediaId },
              })
            : null;
          const activeMedia = await transaction.publicationMedia.count({
            where: {
              publicationId: request.publicationId,
              generationStatus: { in: ['QUEUED', 'RUNNING', 'UPLOADING', 'BLOCKED_FUNDS'] },
            },
          });
          if (
            activeMedia ||
            !selected ||
            selected.status !== 'SELECTED' ||
            selected.generationStatus !== 'READY' ||
            !selected.telegramFileId ||
            selected.approvedTextVersionId !== request.versionId
          )
            throw new ApiHttpException(
              409,
              'MEDIA_UNAVAILABLE',
              'Select an available image for the current text before approval.',
            );
        }
        const now = new Date();
        await transaction.moderationRequest.update({
          where: { id: request.id },
          data: {
            status: 'APPROVED',
            decidedByUserId: userId,
            decidedAt: now,
            version: { increment: 1 },
          },
        });
        await transaction.postVersion.update({
          where: { id: request.versionId },
          data: { status: 'APPROVED', approvedAt: now },
        });
        const publication = await transaction.publication.update({
          where: { id: request.publicationId },
          data: {
            status: 'READY',
            selectedVersionId: request.versionId,
            version: { increment: 1 },
          },
        });
        await this.audit(transaction, userId, request.id, 'moderation.approved', {
          publicationId: request.publicationId,
          versionId: request.versionId,
        });
        return toPublicationView(publication);
      },
    });
  }

  reject(
    userId: string,
    requestId: string,
    version: number,
    key: string,
  ): Promise<PublicationView> {
    return this.idempotency.execute({
      userId,
      operation: `moderation.reject:${requestId}`,
      key,
      requestHash: this.idempotency.digest({ requestId, version }),
      handler: async (transaction) => {
        const request = await this.pendingRequest(transaction, userId, requestId, version);
        if (request.publication.fundingMode === 'PREPAID')
          await this.media.cancelPending(transaction, request.publication);
        const now = new Date();
        await transaction.moderationRequest.update({
          where: { id: request.id },
          data: {
            status: 'REJECTED',
            decidedByUserId: userId,
            decidedAt: now,
            version: { increment: 1 },
          },
        });
        await transaction.postVersion.update({
          where: { id: request.versionId },
          data: { status: 'REJECTED' },
        });
        const publication = await transaction.publication.update({
          where: { id: request.publicationId },
          data: { status: 'CANCELLED', version: { increment: 1 } },
        });
        if (
          request.publication.fundingMode === 'LEGACY' &&
          request.publication.post.generateImage
        ) {
          await this.funding.releaseImage(
            userId,
            request.publicationId,
            transaction,
            undefined,
            false,
          );
        }
        await this.audit(transaction, userId, request.id, 'moderation.rejected', {
          publicationId: request.publicationId,
          versionId: request.versionId,
        });
        return toPublicationView(publication);
      },
    });
  }

  requestRevision(
    userId: string,
    requestId: string,
    version: number,
    feedback: string,
    key: string,
    confirmationId?: string,
  ): Promise<PublicationView> {
    const normalizedFeedback = feedback.trim();
    if (!normalizedFeedback) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_REVISION_FEEDBACK',
        'Revision feedback must not be empty.',
      );
    }
    return this.idempotency.execute({
      userId,
      operation: `moderation.revision:${requestId}`,
      key,
      requestHash: this.idempotency.digest({
        requestId,
        version,
        feedback: normalizedFeedback,
        ...(confirmationId ? { confirmationId } : {}),
      }),
      handler: async (transaction) => {
        const request = await this.pendingRequest(transaction, userId, requestId, version);
        const now = new Date();
        const nextModerationVersion = request.version + 1;
        // A request's optimistic-lock version is reset for each generated
        // version. Use the source PostVersion sequence so ledger keys stay
        // unique across a chain of revisions.
        const revisionKey = `revision:${request.versionId}`;
        const textReserveKey = `publication:${request.publicationId}:${revisionKey}:text-generation:reserve`;
        const allowanceKey = `publication:${request.publicationId}:${revisionKey}:included-revision`;
        const prepaidIntent =
          request.publication.fundingMode === 'PREPAID'
            ? await this.prepaid.authorizeRevision(transaction, {
                userId,
                publicationId: request.publicationId,
                requestId,
                version,
                ...(confirmationId ? { confirmationId } : {}),
              })
            : null;
        if (!prepaidIntent) {
          await this.usage.reserve({
            userId,
            metric: 'MODERATION_REVISION',
            amount: 1,
            operationKey: allowanceKey,
            metadata: { publicationId: request.publicationId },
            database: transaction,
          });
          await this.usage.commit({
            userId,
            metric: 'MODERATION_REVISION',
            amount: 1,
            operationKey: `moderation:${request.id}:${revisionKey}:commit`,
            metadata: { publicationId: request.publicationId },
            database: transaction,
          });
          await this.usage.reserve({
            userId,
            metric: 'TEXT_GENERATION',
            amount: 1,
            operationKey: textReserveKey,
            metadata: { publicationId: request.publicationId },
            database: transaction,
          });
        }
        await transaction.moderationRequest.update({
          where: { id: request.id },
          data: {
            status: 'REVISION_REQUESTED',
            feedback: normalizedFeedback,
            decidedByUserId: userId,
            decidedAt: now,
            version: nextModerationVersion,
          },
        });
        await transaction.postVersion.update({
          where: { id: request.versionId },
          data: { status: 'SUPERSEDED' },
        });
        await transaction.publication.update({
          where: { id: request.publicationId },
          data: {
            status: 'PENDING',
            selectedVersionId: null,
            fundingStatus: 'READY',
            errorCode: null,
            version: { increment: 1 },
            ...(prepaidIntent
              ? {
                  textFundingKind: prepaidIntent.kind,
                  textFundingKey: prepaidIntent.key,
                  textRevisionRequestId: requestId,
                }
              : {}),
          },
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateType: 'Publication',
            aggregateId: request.publicationId,
            eventType: 'publication.generation.requested.v1',
            payload: { schemaVersion: 1, publicationId: request.publicationId },
          },
        });
        await this.audit(transaction, userId, request.id, 'moderation.revision_requested', {
          ...(prepaidIntent
            ? {
                fundingKind: prepaidIntent.kind,
                units: prepaidIntent.kind === 'PAID_REVISION' ? 1 : 0,
              }
            : {}),
          publicationId: request.publicationId,
          versionId: request.versionId,
        });
        const publication = await transaction.publication.findUniqueOrThrow({
          where: { id: request.publicationId },
        });
        return toPublicationView(publication);
      },
    });
  }

  private async pendingRequest(
    database: PrismaService | Prisma.TransactionClient,
    userId: string,
    requestId: string,
    version: number,
  ) {
    const request = await database.moderationRequest.findFirst({
      where: { id: requestId, post: { userId } },
      include: moderationInclude,
    });
    if (!request) {
      throw new ApiHttpException(
        HttpStatus.NOT_FOUND,
        'MODERATION_NOT_FOUND',
        'Moderation request not found.',
      );
    }
    if (request.version !== version) this.stale(request.version);
    if (request.status !== 'PENDING') {
      throw new ApiHttpException(
        HttpStatus.CONFLICT,
        'MODERATION_ALREADY_DECIDED',
        'Moderation request is no longer pending.',
      );
    }
    if (
      request.postVersion.status !== PostVersionStatus.GENERATED ||
      request.publication.status !== PublicationStatus.AWAITING_MODERATION
    ) {
      throw new ApiHttpException(
        HttpStatus.CONFLICT,
        'MODERATION_NOT_READY',
        'Moderation request is not ready for a decision.',
      );
    }
    return request;
  }

  private audit(
    transaction: Prisma.TransactionClient,
    userId: string,
    entityId: string,
    action: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return transaction.auditEvent.create({
      data: {
        userId,
        actorType: 'USER',
        actorId: userId,
        action,
        entityType: 'ModerationRequest',
        entityId,
        metadata,
      },
    });
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
