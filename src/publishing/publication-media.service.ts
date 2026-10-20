import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PublicationMedia } from '../generated/prisma/client.js';
import type { AppEnvironment } from '../config/environment.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { ImageTempService } from '../infrastructure/image-temp/image-temp.service.js';
import { WalletService } from '../generation-packs/wallet.service.js';
import {
  ImageGenerationAdapter,
  ImageGenerationProviderError,
} from './image-generation.adapter.js';
import {
  TelegramPublicationAdapter,
  TelegramPublicationError,
  type TelegramPhotoResult,
} from './telegram-publication.adapter.js';

const active = ['QUEUED', 'RUNNING', 'UPLOADING', 'BLOCKED_FUNDS'] as const;
const mutable = new Set(['AWAITING_MODERATION', 'AWAITING_MEDIA', 'READY']);
const include = { post: { include: { user: { include: { telegramAccount: true } } } } } as const;
type Owned = Prisma.PublicationGetPayload<{ include: typeof include }>;

export function mediaImageEnabled(pub: { definition: unknown; post: { generateImage: boolean } }) {
  const def = pub.definition as { generateImage?: unknown } | null;
  return typeof def?.generateImage === 'boolean' ? def.generateImage : pub.post.generateImage;
}
function auto(pub: Owned) {
  return (
    ((pub.definition as { publicationMode?: string } | null)?.publicationMode ??
      pub.post.publicationMode) === 'AUTO'
  );
}

@Injectable()
export class PublicationMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly idempotency: IdempotencyService,
    private readonly wallet: WalletService,
    private readonly images: ImageGenerationAdapter,
    private readonly telegram: TelegramPublicationAdapter,
    private readonly temporary: ImageTempService,
  ) {}

  async list(userId: string, publicationId: string) {
    return serializableTransaction(this.prisma, async (tx) => {
      const pub = await this.owned(tx, userId, publicationId);
      const version = await this.textVersion(tx, pub.id);
      const rows = await tx.publicationMedia.findMany({
        where: { publicationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return {
        publicationId,
        publicationVersion: pub.version,
        selectedMediaId: pub.selectedMediaId,
        items: rows.map((row) => this.view(row, version?.id ?? null)),
      };
    });
  }

  preview(userId: string, publicationId: string) {
    return serializableTransaction(this.prisma, async (tx) => {
      const pub = await this.owned(tx, userId, publicationId);
      this.mutable(pub);
      const version = await this.textVersion(tx, publicationId);
      if (!version) throw this.error('MEDIA_TEXT_NOT_READY');
      const balance = await tx.generationWallet.findUnique({
        where: { userId_creditType: { userId, creditType: 'IMAGE' } },
      });
      const quote = await tx.mediaCostConfirmation.create({
        data: {
          userId,
          publicationId,
          publicationVersion: pub.version,
          textVersionId: version.id,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      return {
        publicationId,
        publicationVersion: pub.version,
        textVersionId: version.id,
        creditType: 'IMAGE',
        units: 1,
        available: balance?.available ?? 0,
        debt: balance?.debt ?? 0,
        costConfirmationId: quote.id,
        expiresAt: quote.expiresAt.toISOString(),
      };
    });
  }

  request(
    userId: string,
    publicationId: string,
    version: number,
    confirmationId: string,
    key: string,
  ) {
    return this.idempotency.execute({
      userId,
      operation: `media.request:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId, version, confirmationId }),
      handler: async (tx) => {
        const pub = await this.owned(tx, userId, publicationId);
        this.mutable(pub);
        this.version(pub, version);
        if (
          await tx.publicationMedia.findFirst({
            where: { publicationId, generationStatus: { in: [...active] } },
          })
        )
          throw this.error('MEDIA_GENERATION_IN_PROGRESS');
        const text = await this.textVersion(tx, publicationId);
        const quote = await tx.mediaCostConfirmation.findUnique({ where: { id: confirmationId } });
        if (
          !text ||
          !quote ||
          quote.userId !== userId ||
          quote.publicationId !== publicationId ||
          quote.publicationVersion !== version ||
          quote.textVersionId !== text.id ||
          quote.consumedAt ||
          quote.expiresAt <= new Date()
        )
          throw this.error('STALE_COST_CONFIRMATION');
        await tx.mediaCostConfirmation.update({
          where: { id: quote.id },
          data: { consumedAt: new Date() },
        });
        const mediaId = randomUUID();
        const row = await tx.publicationMedia.create({
          data: {
            id: mediaId,
            publicationId,
            sourceVersionId: text.id,
            generationOperationKey: `media:${mediaId}:image`,
          },
        });
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            version: { increment: 1 },
            ...(auto(pub) || pub.selectedVersionId ? { status: 'AWAITING_MEDIA' } : {}),
          },
        });
        await this.audit(tx, publicationId, 'media.requested', { mediaId, units: 1 });
        return this.view(row, text.id);
      },
    });
  }

  select(
    userId: string,
    publicationId: string,
    mediaId: string,
    version: number,
    keepOutdated: boolean,
    key: string,
  ) {
    return this.idempotency.execute({
      userId,
      operation: `media.select:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId, mediaId, version, keepOutdated }),
      handler: async (tx) => {
        const pub = await this.owned(tx, userId, publicationId);
        this.mutable(pub);
        this.version(pub, version);
        const row = await tx.publicationMedia.findFirst({ where: { id: mediaId, publicationId } });
        if (!row) throw this.error('MEDIA_NOT_FOUND', 404);
        if (
          row.generationStatus !== 'READY' ||
          !row.telegramFileId ||
          !['READY', 'SELECTED'].includes(row.status)
        )
          throw this.error('MEDIA_UNAVAILABLE');
        if (
          await tx.publicationMedia.findFirst({
            where: { publicationId, generationStatus: { in: [...active] } },
          })
        )
          throw this.error('MEDIA_GENERATION_IN_PROGRESS');
        const text = await this.textVersion(tx, publicationId);
        if (!text || (row.sourceVersionId !== text.id && !keepOutdated))
          throw this.error('MEDIA_OUTDATED');
        await tx.publicationMedia.updateMany({
          where: { publicationId, status: 'SELECTED', id: { not: mediaId } },
          data: { status: 'READY' },
        });
        const selected = await tx.publicationMedia.update({
          where: { id: mediaId },
          data: { status: 'SELECTED', approvedAt: new Date(), approvedTextVersionId: text.id },
        });
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            selectedMediaId: mediaId,
            version: { increment: 1 },
            fundingStatus: 'READY',
            errorCode: null,
            ...(auto(pub) || pub.selectedVersionId === text.id ? { status: 'READY' } : {}),
          },
        });
        await this.audit(tx, publicationId, 'media.selected', {
          mediaId,
          keptOutdated: row.sourceVersionId !== text.id,
        });
        return this.view(selected, text.id);
      },
    });
  }

  reject(userId: string, publicationId: string, mediaId: string, version: number, key: string) {
    return this.idempotency.execute({
      userId,
      operation: `media.reject:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId, mediaId, version }),
      handler: async (tx) => {
        const pub = await this.owned(tx, userId, publicationId);
        this.mutable(pub);
        this.version(pub, version);
        const row = await tx.publicationMedia.findFirst({ where: { id: mediaId, publicationId } });
        if (!row) throw this.error('MEDIA_NOT_FOUND', 404);
        if (row.generationStatus === 'UPLOADING') throw this.error('MEDIA_GENERATION_IN_PROGRESS');
        if (active.includes(row.generationStatus as (typeof active)[number]))
          await this.release(tx, pub, row);
        const rejected = await tx.publicationMedia.update({
          where: { id: mediaId },
          data: {
            status: 'REJECTED',
            ...(row.generationStatus !== 'READY'
              ? { generationStatus: 'FAILED', errorCode: 'MEDIA_CANCELLED' }
              : {}),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            version: { increment: 1 },
            fundingStatus: 'READY',
            ...(pub.selectedMediaId === mediaId
              ? {
                  selectedMediaId: null,
                  ...(auto(pub) || pub.selectedVersionId ? { status: 'AWAITING_MEDIA' } : {}),
                }
              : {}),
          },
        });
        return this.view(rejected, (await this.textVersion(tx, publicationId))?.id ?? null);
      },
    });
  }

  resume(userId: string, publicationId: string, mediaId: string, key: string) {
    return this.idempotency.execute({
      userId,
      operation: `media.resume:${mediaId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId, mediaId }),
      handler: async (tx) => {
        const pub = await this.owned(tx, userId, publicationId);
        this.mutable(pub);
        const row = await tx.publicationMedia.findFirst({ where: { id: mediaId, publicationId } });
        if (!row) throw this.error('MEDIA_NOT_FOUND', 404);
        if (row.generationStatus !== 'BLOCKED_FUNDS') throw this.error('MEDIA_NOT_RESUMABLE');
        const resumed = await tx.publicationMedia.update({
          where: { id: mediaId },
          data: { generationStatus: 'QUEUED', nextAttemptAt: new Date(), errorCode: null },
        });
        await tx.publication.update({
          where: { id: publicationId },
          data: { version: { increment: 1 }, fundingStatus: 'READY', errorCode: null },
        });
        return this.view(resumed, (await this.textVersion(tx, publicationId))?.id ?? null);
      },
    });
  }

  async cancelPending(tx: Prisma.TransactionClient, pub: { id: string; post: { userId: string } }) {
    const rows = await tx.publicationMedia.findMany({
      where: { publicationId: pub.id, generationStatus: { in: [...active] } },
    });
    if (rows.some((row) => row.generationStatus === 'UPLOADING'))
      throw this.error('MEDIA_GENERATION_IN_PROGRESS');
    for (const row of rows) {
      await this.release(tx, pub, row);
      await tx.publicationMedia.update({
        where: { id: row.id },
        data: {
          status: 'REJECTED',
          generationStatus: 'FAILED',
          errorCode: 'MEDIA_CANCELLED',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    }
  }

  async process(mediaId: string): Promise<void> {
    const claim = await serializableTransaction(this.prisma, async (tx) => {
      const row = await tx.publicationMedia.findUnique({ where: { id: mediaId } });
      if (
        !row ||
        row.nextAttemptAt > new Date() ||
        !['QUEUED', 'RUNNING', 'UPLOADING'].includes(row.generationStatus)
      )
        return null;
      if (
        row.generationStatus !== 'QUEUED' &&
        row.leaseExpiresAt &&
        row.leaseExpiresAt > new Date()
      )
        return null;
      const pub = await tx.publication.findUniqueOrThrow({
        where: { id: row.publicationId },
        include,
      });
      if (row.generationStatus === 'UPLOADING') {
        await this.fail(tx, pub, row, 'MEDIA_UPLOAD_UNKNOWN', true);
        return null;
      }
      if (row.generationAttempts >= this.config.get('PUBLICATION_MAX_ATTEMPTS', { infer: true })) {
        await this.fail(tx, pub, row, 'MEDIA_RETRY_EXHAUSTED');
        return null;
      }
      if (
        pub.fundingMode !== 'PREPAID' ||
        !mutable.has(pub.status) ||
        !row.generationOperationKey ||
        !row.sourceVersionId
      ) {
        await this.fail(tx, pub, row, 'MEDIA_CANCELLED');
        return null;
      }
      const text = await tx.postVersion.findUniqueOrThrow({ where: { id: row.sourceVersionId } });
      if (!text.text || !pub.post.user.telegramAccount) {
        await this.fail(tx, pub, row, 'MEDIA_PREVIEW_UNAVAILABLE');
        return null;
      }
      try {
        await this.wallet.reserve(
          {
            userId: pub.post.userId,
            publicationId: pub.id,
            creditType: 'IMAGE',
            units: 1,
            operationKey: row.generationOperationKey,
          },
          tx,
        );
      } catch (error) {
        if (
          !(error instanceof ApiHttpException) ||
          (error.getResponse() as { code?: string }).code !== 'INSUFFICIENT_IMAGE_CREDITS'
        )
          throw error;
        await tx.publicationMedia.update({
          where: { id: row.id },
          data: {
            generationStatus: 'BLOCKED_FUNDS',
            errorCode: 'INSUFFICIENT_IMAGE_CREDITS',
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (!pub.selectedMediaId)
          await tx.publication.update({
            where: { id: pub.id },
            data: {
              fundingStatus: 'BLOCKED_FUNDS',
              errorCode: 'INSUFFICIENT_IMAGE_CREDITS',
              version: { increment: 1 },
            },
          });
        await this.audit(tx, pub.id, 'media.blocked_funds', { mediaId });
        return null;
      }
      const hold = await tx.generationReservation.findUniqueOrThrow({
        where: { operationKey: row.generationOperationKey },
      });
      let aiRequestId = hold.aiRequestId;
      if (!aiRequestId) {
        const ai = await tx.aIRequest.create({
          data: {
            userId: pub.post.userId,
            postId: pub.postId,
            publicationId: pub.id,
            kind: 'IMAGE',
            provider: 'gptunnel',
            model: this.config.get('AI_IMAGE_MODEL', { infer: true }),
            status: 'RUNNING',
            startedAt: new Date(),
          },
        });
        aiRequestId = ai.id;
        await tx.generationReservation.update({ where: { id: hold.id }, data: { aiRequestId } });
      }
      const token = randomUUID();
      const leaseExpiresAt = new Date(
        Date.now() +
          this.config.get('AI_IMAGE_TIMEOUT_MS', { infer: true }) +
          this.config.get('TELEGRAM_API_TIMEOUT_MS', { infer: true }) +
          60_000,
      );
      await tx.publicationMedia.update({
        where: { id: mediaId },
        data: {
          generationStatus: 'RUNNING',
          generationAttempts: { increment: 1 },
          leaseToken: token,
          leaseExpiresAt,
        },
      });
      return {
        row,
        pub,
        token,
        aiRequestId,
        text: text.text,
        chatId: pub.post.user.telegramAccount.telegramUserId,
      };
    });
    if (!claim) return;
    let path: string | undefined;
    let uploaded: TelegramPhotoResult;
    try {
      const def = claim.pub.definition as { prompt?: string } | null;
      const image = await this.images.generate({
        prompt: def?.prompt ?? claim.pub.post.prompt,
        text: claim.text,
        idempotencyKey: claim.row.generationOperationKey!,
      });
      path = image.filePath;
      const uploading = await this.prisma.publicationMedia.updateMany({
        where: { id: mediaId, generationStatus: 'RUNNING', leaseToken: claim.token },
        data: { generationStatus: 'UPLOADING' },
      });
      if (!uploading.count) return;
      if (image.providerRequestId)
        await this.prisma.aIRequest.updateMany({
          where: { id: claim.aiRequestId, status: 'RUNNING' },
          data: { providerRequestId: image.providerRequestId },
        });
      uploaded = await this.telegram.uploadPhoto(
        claim.chatId,
        `Предпросмотр изображения ${mediaId}`,
        path,
      );
      if (uploaded.chatId !== claim.chatId || !uploaded.fileId || !uploaded.fileUniqueId)
        throw new TelegramPublicationError('MEDIA_UNAVAILABLE', false, true);
    } catch (error) {
      await serializableTransaction(this.prisma, async (tx) => {
        const row = await tx.publicationMedia.findFirst({
          where: { id: mediaId, leaseToken: claim.token },
        });
        if (!row) return;
        const ambiguous = error instanceof TelegramPublicationError && error.ambiguous;
        const retryable =
          (error instanceof ImageGenerationProviderError ||
            error instanceof TelegramPublicationError) &&
          error.retryable &&
          !ambiguous;
        const code =
          error instanceof ImageGenerationProviderError || error instanceof TelegramPublicationError
            ? error.code
            : 'MEDIA_GENERATION_FAILED';
        if (
          retryable &&
          row.generationAttempts < this.config.get('PUBLICATION_MAX_ATTEMPTS', { infer: true })
        ) {
          const retryAfter = error.retryAfterSeconds ?? Math.min(60, 2 ** row.generationAttempts);
          await tx.publicationMedia.update({
            where: { id: mediaId },
            data: {
              generationStatus: 'QUEUED',
              nextAttemptAt: new Date(Date.now() + retryAfter * 1000),
              leaseToken: null,
              leaseExpiresAt: null,
              errorCode: code,
            },
          });
        } else
          await this.fail(tx, claim.pub, row, ambiguous ? 'MEDIA_UPLOAD_UNKNOWN' : code, ambiguous);
      });
      return;
    } finally {
      if (path) await this.temporary.remove(path);
    }
    // Persist the accepted Telegram reference and credit commit atomically. A DB error leaves
    // UPLOADING durable; recovery never guesses whether another upload is safe.
    await serializableTransaction(this.prisma, async (tx) => {
      const row = await tx.publicationMedia.findFirst({
        where: { id: mediaId, generationStatus: 'UPLOADING', leaseToken: claim.token },
      });
      if (!row) return;
      const pub = await tx.publication.findUniqueOrThrow({
        where: { id: row.publicationId },
        include,
      });
      await this.wallet.commit(
        {
          userId: pub.post.userId,
          publicationId: pub.id,
          creditType: 'IMAGE',
          units: 1,
          operationKey: row.generationOperationKey!,
        },
        tx,
      );
      await tx.aIRequest.updateMany({
        where: { id: claim.aiRequestId, status: 'RUNNING' },
        data: { status: 'SUCCEEDED', completedAt: new Date() },
      });
      const text = await this.textVersion(tx, pub.id);
      const selected = auto(pub) && text?.id === row.sourceVersionId && mutable.has(pub.status);
      if (selected)
        await tx.publicationMedia.updateMany({
          where: { publicationId: pub.id, status: 'SELECTED' },
          data: { status: 'READY' },
        });
      await tx.publicationMedia.update({
        where: { id: mediaId },
        data: {
          generationStatus: 'READY',
          status: selected ? 'SELECTED' : 'READY',
          telegramFileId: uploaded.fileId,
          telegramFileUniqueId: uploaded.fileUniqueId,
          telegramChatId: uploaded.chatId,
          telegramMessageId: uploaded.messageId,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          ...(selected ? { approvedTextVersionId: text.id, approvedAt: new Date() } : {}),
        },
      });
      await tx.publication.update({
        where: { id: pub.id },
        data: {
          version: { increment: 1 },
          ...(selected || pub.errorCode === 'INSUFFICIENT_IMAGE_CREDITS'
            ? { fundingStatus: 'READY', errorCode: null }
            : {}),
          ...(selected ? { selectedMediaId: mediaId, status: 'READY' } : {}),
        },
      });
      await this.audit(tx, pub.id, 'media.generated', { mediaId, units: 1 });
    });
  }

  private async fail(
    tx: Prisma.TransactionClient,
    pub: { id: string; post: { userId: string } },
    row: PublicationMedia,
    code: string,
    ambiguous = false,
  ) {
    await this.release(tx, pub, row);
    await tx.publicationMedia.update({
      where: { id: row.id },
      data: {
        generationStatus: ambiguous ? 'UPLOAD_UNKNOWN' : 'FAILED',
        status: 'UNAVAILABLE',
        errorCode: code,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const current = await tx.publication.findUniqueOrThrow({ where: { id: pub.id } });
    await tx.publication.update({
      where: { id: pub.id },
      data: {
        version: { increment: 1 },
        ...(['PENDING', 'GENERATING'].includes(current.status)
          ? {}
          : { fundingStatus: 'READY', errorCode: code }),
      },
    });
    await this.audit(tx, pub.id, 'media.failed', { mediaId: row.id, code });
  }
  private async release(
    tx: Prisma.TransactionClient,
    pub: { post: { userId: string } },
    row: PublicationMedia,
  ) {
    if (!row.generationOperationKey) return;
    const hold = await tx.generationReservation.findUnique({
      where: { operationKey: row.generationOperationKey },
    });
    if (hold?.aiRequestId)
      await tx.aIRequest.updateMany({
        where: { id: hold.aiRequestId, status: 'RUNNING' },
        data: { status: 'FAILED', errorCode: 'MEDIA_NOT_ACCEPTED', completedAt: new Date() },
      });
    if (hold?.status === 'RESERVED')
      await this.wallet.release(
        {
          userId: pub.post.userId,
          creditType: 'IMAGE',
          units: 1,
          operationKey: row.generationOperationKey,
        },
        tx,
      );
  }
  private async owned(tx: Prisma.TransactionClient, userId: string, publicationId: string) {
    const pub = await tx.publication.findFirst({
      where: { id: publicationId, post: { userId } },
      include,
    });
    if (!pub) throw this.error('PUBLICATION_NOT_FOUND', 404);
    if (pub.fundingMode !== 'PREPAID' || !mediaImageEnabled(pub))
      throw this.error('PREPAID_MEDIA_NOT_APPLICABLE');
    return pub;
  }
  private mutable(pub: Owned) {
    if (
      !mutable.has(pub.status) &&
      !(pub.status === 'FAILED' && pub.errorCode === 'MEDIA_UNAVAILABLE')
    )
      throw this.error('MEDIA_NOT_MUTABLE');
  }
  private version(pub: Owned, version: number) {
    if (pub.version !== version) throw this.error('STALE_RESOURCE_VERSION');
  }
  private async textVersion(tx: Prisma.TransactionClient, publicationId: string) {
    return tx.postVersion.findFirst({
      where: { publicationId, status: { in: ['GENERATED', 'APPROVED'] } },
      orderBy: { sequence: 'desc' },
    });
  }
  private view(row: PublicationMedia, textVersionId: string | null) {
    return {
      id: row.id,
      publicationId: row.publicationId,
      status: row.status,
      generationStatus: row.generationStatus,
      sourceVersionId: row.sourceVersionId,
      approvedTextVersionId: row.approvedTextVersionId,
      isOutdated: row.sourceVersionId !== textVersionId,
      selectionIsCurrent: row.approvedTextVersionId === textVersionId,
      telegramFileId: row.telegramFileId,
      telegramFileUniqueId: row.telegramFileUniqueId,
      telegramChatId: row.telegramChatId?.toString() ?? null,
      telegramMessageId: row.telegramMessageId?.toString() ?? null,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private audit(
    tx: Prisma.TransactionClient,
    publicationId: string,
    action: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return tx.auditEvent.create({
      data: {
        actorType: 'SYSTEM',
        actorId: 'media-worker',
        action,
        entityType: 'Publication',
        entityId: publicationId,
        metadata,
      },
    });
  }
  private error(code: string, status = 409) {
    return new ApiHttpException(status, code, 'Media operation could not be completed.');
  }
}
