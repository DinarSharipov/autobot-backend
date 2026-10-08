import type { Prisma } from '../generated/prisma/client.js';

export type UserWithTelegram = Prisma.UserGetPayload<{
  include: { telegramAccount: true };
}>;

export type UserView = {
  id: string;
  status: 'ACTIVE' | 'BLOCKED';
  locale: string;
  timezone: string;
  telegram: {
    telegramUserId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    photoUrl: string | null;
  };
  createdAt: string;
};

export function toUserView(user: UserWithTelegram): UserView {
  if (!user.telegramAccount || user.status === 'DELETED') {
    throw new Error('An active user view requires a Telegram account');
  }

  return {
    id: user.id,
    status: user.status,
    locale: user.locale,
    timezone: user.timezone,
    telegram: {
      telegramUserId: user.telegramAccount.telegramUserId.toString(),
      username: user.telegramAccount.username,
      firstName: user.telegramAccount.firstName,
      lastName: user.telegramAccount.lastName,
      photoUrl: user.telegramAccount.photoUrl,
    },
    createdAt: user.createdAt.toISOString(),
  };
}
