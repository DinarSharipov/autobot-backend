import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PublicationStatus } from '../generated/prisma/client.js';

import type { AppEnvironment } from '../config/environment.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { ImageTempService } from '../infrastructure/image-temp/image-temp.service.js';
import { UsageService } from '../subscriptions/usage.service.js';
import { toPublicationView, type PublicationView } from '../posts/post.types.js';
import {
  TelegramPublicationAdapter,
  TelegramPublicationError,
} from './telegram-publication.adapter.js';
import {
  ImageGenerationAdapter,
  ImageGenerationProviderError,
} from './image-generation.adapter.js';
import type { PublicationListQuery } from './publishing.dto.js';

const RETRYABLE_CODES = new Set([
  'TELEGRAM_RATE_LIMIT',
  'TELEGRAM_API_UNAVAILABLE',
  'TELEGRAM_NOT_CONFIGURED',
  'PUBLICATION_IMAGE_UNAVAILABLE',
  'AI_IMAGE_PROVIDER_NETWORK_ERROR',
  'AI_IMAGE_PROVIDER_RATE_LIMITED',
  'AI_IMAGE_TEMP_STORAGE_UNAVAILABLE',
  'AI_IMAGE_DOWNLOAD_FAILED',
  'AI_IMAGE_PROVIDER_TIMEOUT',
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_NETWORK_ERROR',
  'AI_PROVIDER_RATE_LIMITED',
  'AI_PROVIDER_HTTP_408',
  'AI_PROVIDER_HTTP_500',
  'AI_PROVIDER_HTTP_502',
  'AI_PROVIDER_HTTP_503',
  'AI_PROVIDER_HTTP_504',
]);

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly adapter: TelegramPublicationAdapter,
    private readonly imageGeneration: ImageGenerationAdapter,
    private readonly temporaryImages: ImageTempService,
    private readonly idempotency: IdempotencyService,
    private readonly usage: UsageService,
  ) {}

  async list(userId: string, query: PublicationListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.publication.findMany({
      where: {
        post: { userId },
        ...(query.status ? { status: query.status } : {}),
        ...(query.postId ? { postId: query.postId } : {}),
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
      data: data.map(toPublicationView),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async get(userId: string, publicationId: string): Promise<PublicationView> {
    const publication = await this.prisma.publication.findFirst({
      where: { id: publicationId, post: { userId } },
    });
    if (!publication) this.notFound();
    return toPublicationView(publication);
  }

  async publish(publicationId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.publication.updateMany({
      where: {
        id: publicationId,
        OR: [
          { status: PublicationStatus.READY },
          { status: PublicationStatus.RETRY_WAIT, nextAttemptAt: { lte: now } },
        ],
      },
      data: { status: PublicationStatus.PUBLISHING, attemptCount: { increment: 1 } },
    });
    if (!claimed.count) return;

    const publication = await this.prisma.publication.findUnique({
      where: { id: publicationId },
      include: { selectedVersion: true, post: { include: { channel: true } } },
    });
    if (!publication) return;
    if (!publication.selectedVersion?.text?.trim()) {
      await this.fail(
        publicationId,
        'PUBLICATION_TEXT_NOT_AVAILABLE',
        'Selected text is missing.',
        Boolean(publication.post.generateImage),
      );
      return;
    }

    let imagePath: string | undefined;
    let imageUsageCommitted = false;
    try {
      const result = publication.post.generateImage
        ? await this.publishWithImage(
            publication,
            (path) => {
              imagePath = path;
            },
            () => {
              imageUsageCommitted = true;
            },
          )
        : await this.adapter.sendText(
            publication.post.channel.telegramChatId,
            publication.selectedVersion.text,
          );
      await this.prisma.publication.updateMany({
        where: { id: publicationId, status: PublicationStatus.PUBLISHING },
        data: {
          status: PublicationStatus.PUBLISHED,
          telegramChatId: result.chatId,
          telegramMessageId: result.messageId,
          publishedWithImage: publication.post.generateImage,
          publishedAt: new Date(),
          nextAttemptAt: null,
          errorCode: null,
          errorDetails: Prisma.JsonNull,
        },
      });
    } catch (error) {
      await this.handleError(
        publicationId,
        publication.attemptCount,
        error,
        publication.post.generateImage && !imageUsageCommitted,
      );
    } finally {
      if (imagePath) await this.temporaryImages.remove(imagePath);
    }
  }

  private async publishWithImage(
    publication: {
      id: string;
      post: { prompt: string; userId: string; channel: { telegramChatId: bigint } };
      selectedVersion: { text: string | null } | null;
    },
    onPath: (path: string) => void,
    onUsageCommitted: () => void,
  ) {
    const image = await this.imageGeneration.generate({
      prompt: publication.post.prompt,
      text: publication.selectedVersion!.text!,
      idempotencyKey: `publication:${publication.id}:image`,
    });
    onPath(image.filePath);
    await this.usage.commit({
      userId: publication.post.userId,
      metric: 'IMAGE_GENERATION',
      amount: 1,
      operationKey: `publication:${publication.id}:image-generation:commit`,
      metadata: { publicationId: publication.id },
    });
    onUsageCommitted();
    return this.adapter.sendPhoto(
      publication.post.channel.telegramChatId,
      publication.selectedVersion!.text!,
      image.filePath,
    );
  }

  async retry(userId: string, publicationId: string, key: string): Promise<PublicationView> {
    return this.idempotency.execute({
      userId,
      operation: `publications.retry:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId }),
      handler: async (transaction) => {
        const publication = await transaction.publication.findFirst({
          where: { id: publicationId, post: { userId } },
        });
        if (!publication) this.notFound();
        if (
          publication.status !== PublicationStatus.FAILED ||
          !RETRYABLE_CODES.has(publication.errorCode ?? '')
        ) {
          throw new ApiHttpException(
            HttpStatus.CONFLICT,
            'PUBLICATION_NOT_RETRYABLE',
            'Only retryable failed publications can be retried.',
          );
        }
        const updated = await transaction.publication.update({
          where: { id: publication.id },
          data: {
            status: PublicationStatus.READY,
            attemptCount: 0,
            nextAttemptAt: null,
            errorCode: null,
            errorDetails: Prisma.JsonNull,
          },
        });
        return toPublicationView(updated);
      },
    });
  }

  async cancel(userId: string, publicationId: string, key: string): Promise<PublicationView> {
    return this.idempotency.execute({
      userId,
      operation: `publications.cancel:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId }),
      handler: async (transaction) => {
        const publication = await transaction.publication.findFirst({
          where: { id: publicationId, post: { userId } },
          include: { post: true },
        });
        if (!publication) this.notFound();
        const cancellable = new Set<PublicationStatus>([
          PublicationStatus.PENDING,
          PublicationStatus.AWAITING_MODERATION,
          PublicationStatus.READY,
          PublicationStatus.RETRY_WAIT,
        ]);
        if (!cancellable.has(publication.status)) {
          if (publication.status === PublicationStatus.CANCELLED)
            return toPublicationView(publication);
          throw new ApiHttpException(
            HttpStatus.CONFLICT,
            'PUBLICATION_NOT_CANCELLABLE',
            'Publication delivery has already started.',
          );
        }
        if (publication.status === PublicationStatus.PENDING) {
          await this.usage.release({
            userId: publication.post.userId,
            metric: 'TEXT_GENERATION',
            amount: 1,
            operationKey: `publication:${publication.id}:text-generation:release`,
            metadata: { publicationId: publication.id },
            database: transaction,
          });
        }
        if (publication.post.generateImage) {
          await this.usage.release({
            userId: publication.post.userId,
            metric: 'IMAGE_GENERATION',
            amount: 1,
            operationKey: `publication:${publication.id}:image-generation:release`,
            metadata: { publicationId: publication.id },
            database: transaction,
          });
        }
        return toPublicationView(
          await transaction.publication.update({
            where: { id: publication.id },
            data: { status: PublicationStatus.CANCELLED, nextAttemptAt: null },
          }),
        );
      },
    });
  }

  private async handleError(
    publicationId: string,
    attemptCount: number,
    error: unknown,
    releaseImage: boolean,
  ): Promise<void> {
    if (error instanceof TelegramPublicationError && error.ambiguous) {
      await this.prisma.publication.updateMany({
        where: { id: publicationId, status: PublicationStatus.PUBLISHING },
        data: {
          status: PublicationStatus.DELIVERY_UNKNOWN,
          errorCode: error.code,
          errorDetails: { message: error.message },
        },
      });
      return;
    }
    const code =
      error instanceof TelegramPublicationError || error instanceof ImageGenerationProviderError
        ? error.code
        : 'TELEGRAM_API_UNAVAILABLE';
    const message = error instanceof Error ? error.message : 'Telegram publication failed.';
    const retryable =
      error instanceof TelegramPublicationError || error instanceof ImageGenerationProviderError
        ? error.retryable
        : true;
    const maxAttempts = this.config.get('PUBLICATION_MAX_ATTEMPTS', { infer: true });
    if (retryable && attemptCount < maxAttempts) {
      const retryAfter =
        error instanceof TelegramPublicationError || error instanceof ImageGenerationProviderError
          ? error.retryAfterSeconds
          : undefined;
      const delaySeconds = retryAfter ?? Math.min(3600, 2 ** Math.max(0, attemptCount - 1));
      await this.prisma.publication.updateMany({
        where: { id: publicationId, status: PublicationStatus.PUBLISHING },
        data: {
          status: PublicationStatus.RETRY_WAIT,
          nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
          errorCode: code,
          errorDetails: { message },
        },
      });
      return;
    }
    await this.fail(publicationId, code, message, releaseImage);
  }

  private async fail(
    publicationId: string,
    code: string,
    message: string,
    releaseImage = false,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.publication.updateMany({
        where: { id: publicationId, status: PublicationStatus.PUBLISHING },
        data: {
          status: PublicationStatus.FAILED,
          errorCode: code,
          errorDetails: { message },
          nextAttemptAt: null,
        },
      });
      if (updated.count && releaseImage) {
        const publication = await transaction.publication.findUnique({
          where: { id: publicationId },
          include: { post: true },
        });
        if (publication?.post.generateImage) {
          await this.usage.release({
            userId: publication.post.userId,
            metric: 'IMAGE_GENERATION',
            amount: 1,
            operationKey: `publication:${publication.id}:image-generation:release`,
            metadata: { publicationId: publication.id },
            database: transaction,
          });
        }
      }
    });
    this.logger.warn({ event: 'publication_failed', publicationId, code });
  }

  private notFound(): never {
    throw new ApiHttpException(
      HttpStatus.NOT_FOUND,
      'PUBLICATION_NOT_FOUND',
      'Publication not found.',
    );
  }
}
