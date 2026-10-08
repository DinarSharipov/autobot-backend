import { HttpStatus, Injectable } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import { AuthProvider, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import type { UserWithTelegram } from './user.types.js';

export type TelegramProfileData = {
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  languageCode?: string | null;
};

export type TelegramOidcIdentity = TelegramProfileData & {
  subject: string;
};

type TelegramProfileColumns = {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  profileUpdatedAt: Date;
};

const TRANSACTION_ATTEMPTS = 6;

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveBotUser(profile: TelegramProfileData): Promise<UserWithTelegram> {
    const telegramUserId = this.parseTelegramUserId(profile.telegramUserId);

    return this.withIdentityRetry<UserWithTelegram>(async () =>
      this.prisma.$transaction(
        async (transaction): Promise<UserWithTelegram> => {
          const account = await transaction.telegramAccount.findUnique({
            where: { telegramUserId },
            include: { user: { include: { telegramAccount: true } } },
          });

          if (account) {
            await transaction.telegramAccount.update({
              where: { id: account.id },
              data: this.profileUpdate(profile),
            });

            return transaction.user.findUniqueOrThrow({
              where: { id: account.userId },
              include: { telegramAccount: true },
            });
          }

          return transaction.user.create({
            data: {
              ...(profile.languageCode ? { locale: profile.languageCode } : {}),
              telegramAccount: {
                create: {
                  telegramUserId,
                  ...this.profileUpdate(profile),
                },
              },
            },
            include: { telegramAccount: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async resolveOidcUser(identity: TelegramOidcIdentity): Promise<UserWithTelegram> {
    const telegramUserId = this.parseTelegramUserId(identity.telegramUserId);

    return this.withIdentityRetry<UserWithTelegram>(async () =>
      this.prisma.$transaction(
        async (transaction): Promise<UserWithTelegram> => {
          const [authIdentity, telegramAccount] = await Promise.all([
            transaction.authIdentity.findUnique({
              where: {
                provider_subject: { provider: AuthProvider.TELEGRAM, subject: identity.subject },
              },
              include: { telegramAccount: true },
            }),
            transaction.telegramAccount.findUnique({ where: { telegramUserId } }),
          ]);

          if (authIdentity && telegramAccount && authIdentity.userId !== telegramAccount.userId) {
            this.identityConflict();
          }

          if (
            authIdentity?.telegramAccount &&
            authIdentity.telegramAccount.telegramUserId !== telegramUserId
          ) {
            this.identityConflict();
          }

          if (authIdentity) {
            const account =
              telegramAccount ??
              (await transaction.telegramAccount.create({
                data: {
                  userId: authIdentity.userId,
                  telegramUserId,
                  ...this.profileUpdate(identity),
                },
              }));

            await Promise.all([
              transaction.telegramAccount.update({
                where: { id: account.id },
                data: this.profileUpdate(identity),
              }),
              transaction.authIdentity.update({
                where: { id: authIdentity.id },
                data: { telegramAccountId: account.id, lastLoginAt: new Date() },
              }),
            ]);

            return transaction.user.findUniqueOrThrow({
              where: { id: authIdentity.userId },
              include: { telegramAccount: true },
            });
          }

          if (telegramAccount) {
            await Promise.all([
              transaction.telegramAccount.update({
                where: { id: telegramAccount.id },
                data: this.profileUpdate(identity),
              }),
              transaction.authIdentity.create({
                data: {
                  provider: AuthProvider.TELEGRAM,
                  subject: identity.subject,
                  userId: telegramAccount.userId,
                  telegramAccountId: telegramAccount.id,
                  lastLoginAt: new Date(),
                },
              }),
            ]);

            return transaction.user.findUniqueOrThrow({
              where: { id: telegramAccount.userId },
              include: { telegramAccount: true },
            });
          }

          const user = await transaction.user.create({
            data: {
              telegramAccount: {
                create: {
                  telegramUserId,
                  ...this.profileUpdate(identity),
                },
              },
            },
            include: { telegramAccount: true },
          });
          const telegramAccountId = user.telegramAccount?.id;
          if (!telegramAccountId) throw new Error('Telegram account creation failed');

          await transaction.authIdentity.create({
            data: {
              provider: AuthProvider.TELEGRAM,
              subject: identity.subject,
              userId: user.id,
              telegramAccountId,
              lastLoginAt: new Date(),
            },
          });

          return user;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async findByTelegramUserId(telegramUserIdValue: string): Promise<UserWithTelegram | null> {
    const telegramUserId = this.parseTelegramUserId(telegramUserIdValue);
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      include: { user: { include: { telegramAccount: true } } },
    });

    return account?.user ?? null;
  }

  async findUser(userId: string): Promise<UserWithTelegram | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { telegramAccount: true },
    });
  }

  private profileUpdate(profile: TelegramProfileData): TelegramProfileColumns {
    return {
      ...(profile.username !== undefined ? { username: profile.username } : {}),
      ...(profile.firstName !== undefined ? { firstName: profile.firstName } : {}),
      ...(profile.lastName !== undefined ? { lastName: profile.lastName } : {}),
      ...(profile.photoUrl !== undefined ? { photoUrl: profile.photoUrl } : {}),
      profileUpdatedAt: new Date(),
    };
  }

  private parseTelegramUserId(value: string): bigint {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new ApiHttpException(
        HttpStatus.BAD_REQUEST,
        'INVALID_TELEGRAM_USER_ID',
        'Telegram user ID must be a positive decimal string.',
      );
    }

    return BigInt(value);
  }

  private identityConflict(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'IDENTITY_LINK_CONFLICT',
      'Telegram identity mappings conflict and cannot be linked automatically.',
    );
  }

  private async withIdentityRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034');

        if (!retryable || attempt === TRANSACTION_ATTEMPTS) {
          throw error;
        }

        await delay(attempt * 10);
      }
    }

    throw new Error('Identity retry loop exhausted');
  }
}
