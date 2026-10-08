import { HttpStatus, Injectable } from '@nestjs/common';

import { ChannelStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { EntitlementService } from '../subscriptions/entitlement.service.js';
import { type ChannelView, toChannelView } from './channel.types.js';
import type { ChannelCreateDto, ChannelListQuery, ChannelUpdateDto } from './channels.dto.js';
import {
  TelegramChannelAdapter,
  type ValidatedTelegramChannel,
} from './telegram-channel.adapter.js';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramChannelAdapter,
    private readonly entitlements: EntitlementService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(userId: string, query: ChannelListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.channel.findMany({
      where: {
        userId,
        ...(query.status ? { status: query.status } : { status: { not: ChannelStatus.ARCHIVED } }),
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
      data: data.map(toChannelView),
      page: { nextCursor: hasMore && last ? encodeCursor(last) : null, hasMore },
    };
  }

  async get(userId: string, channelId: string): Promise<ChannelView> {
    const channel = await this.prisma.channel.findFirst({ where: { id: channelId, userId } });
    if (!channel) this.notFound();
    return toChannelView(channel);
  }

  async create(
    userId: string,
    dto: ChannelCreateDto,
    idempotencyKey: string,
  ): Promise<ChannelView> {
    const telegramChatId = this.parseTelegramChatId(dto.telegramChatId);
    const requestHash = this.idempotency.digest(dto);
    const command = {
      userId,
      operation: 'channels.create',
      key: idempotencyKey,
      requestHash,
    };
    const replay = await this.idempotency.replay<ChannelView>(command);
    if (replay) return replay;
    const validated = await this.telegram.validate(telegramChatId);

    try {
      return await this.idempotency.execute({
        ...command,
        handler: async (transaction) => {
          const existing = await transaction.channel.findUnique({ where: { telegramChatId } });
          if (existing && (existing.userId !== userId || existing.status !== 'ARCHIVED')) {
            this.alreadyLinked();
          }
          await this.entitlements.assertChannelCapacity(userId, transaction);
          if (existing) {
            const channel = await transaction.channel.update({
              where: { id: existing.id },
              data: {
                title: validated.title,
                username: validated.username,
                status: ChannelStatus.ACTIVE,
                botPermissions: validated.botPermissions,
                verifiedAt: new Date(),
                archivedAt: null,
                version: { increment: 1 },
              },
            });
            await this.audit(transaction, userId, channel.id, 'channel.relinked', {
              telegramChatId: dto.telegramChatId,
            });
            return toChannelView(channel);
          }
          const channel = await transaction.channel.create({
            data: {
              userId,
              telegramChatId,
              title: validated.title,
              username: validated.username,
              status: ChannelStatus.ACTIVE,
              botPermissions: validated.botPermissions,
              verifiedAt: new Date(),
            },
          });
          await this.audit(transaction, userId, channel.id, 'channel.linked', {
            telegramChatId: dto.telegramChatId,
          });
          return toChannelView(channel);
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.alreadyLinked();
      }
      throw error;
    }
  }

  async update(
    userId: string,
    channelId: string,
    version: number,
    dto: ChannelUpdateDto,
  ): Promise<ChannelView> {
    const result = await this.prisma.channel.updateMany({
      where: { id: channelId, userId, version },
      data: { title: dto.title.trim(), version: { increment: 1 } },
    });
    if (result.count === 0) await this.throwMutationMiss(userId, channelId);
    return toChannelView(
      await this.prisma.channel.findFirstOrThrow({ where: { id: channelId, userId } }),
    );
  }

  async archive(userId: string, channelId: string, version: number): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.channel.updateMany({
        where: { id: channelId, userId, version },
        data: {
          status: ChannelStatus.ARCHIVED,
          archivedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (result.count === 0) await this.throwMutationMiss(userId, channelId, transaction);
      await this.audit(transaction, userId, channelId, 'channel.archived');
    });
  }

  async verify(userId: string, channelId: string, idempotencyKey: string): Promise<ChannelView> {
    const requestHash = this.idempotency.digest({ channelId });
    const command = {
      userId,
      operation: `channels.verify:${channelId}`,
      key: idempotencyKey,
      requestHash,
    };
    const replay = await this.idempotency.replay<ChannelView>(command);
    if (replay) return replay;
    const current = await this.prisma.channel.findFirst({ where: { id: channelId, userId } });
    if (!current) this.notFound();
    let validated: ValidatedTelegramChannel;
    try {
      validated = await this.telegram.validate(current.telegramChatId);
    } catch (error) {
      if (error instanceof ApiHttpException && error.getStatus() === 422) {
        await this.prisma.$transaction(async (transaction) => {
          const updated = await transaction.channel.updateMany({
            where: { id: channelId, userId, status: { not: ChannelStatus.ARCHIVED } },
            data: { status: ChannelStatus.INVALID, version: { increment: 1 } },
          });
          if (updated.count > 0) {
            await this.audit(transaction, userId, channelId, 'channel.validation_failed', {
              errorCode: (error.getResponse() as { code?: string }).code ?? 'UNKNOWN',
            });
          }
        });
      }
      throw error;
    }

    return this.idempotency.execute({
      ...command,
      handler: async (transaction) => {
        const channel = await transaction.channel.update({
          where: { id: current.id },
          data: {
            title: validated.title,
            username: validated.username,
            botPermissions: validated.botPermissions,
            status: ChannelStatus.ACTIVE,
            verifiedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.audit(transaction, userId, channelId, 'channel.revalidated');
        return toChannelView(channel);
      },
    });
  }

  private async throwMutationMiss(
    userId: string,
    channelId: string,
    database: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<never> {
    const existing = await database.channel.findFirst({ where: { id: channelId, userId } });
    if (!existing) this.notFound();
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'STALE_RESOURCE_VERSION',
      'The resource version is stale.',
      { currentVersion: existing.version },
    );
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
        entityType: 'Channel',
        entityId,
        ...(metadata ? { metadata } : {}),
      },
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, 'CHANNEL_NOT_FOUND', 'Channel not found.');
  }

  private alreadyLinked(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'CHANNEL_ALREADY_LINKED',
      'The Telegram channel is already linked.',
    );
  }

  private parseTelegramChatId(value: string): bigint {
    const id = BigInt(value);
    if (id < -9_223_372_036_854_775_808n || id > 9_223_372_036_854_775_807n) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_TELEGRAM_CHAT_ID',
        'Telegram chat ID is outside the signed 64-bit range.',
      );
    }
    return id;
  }
}
