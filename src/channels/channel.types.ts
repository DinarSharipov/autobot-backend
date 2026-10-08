import type { Channel } from '../generated/prisma/client.js';

export type ChannelView = {
  id: string;
  telegramChatId: string;
  title: string;
  username: string | null;
  status: Channel['status'];
  verifiedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export function toChannelView(channel: Channel): ChannelView {
  return {
    id: channel.id,
    telegramChatId: channel.telegramChatId.toString(),
    title: channel.title,
    username: channel.username,
    status: channel.status,
    verifiedAt: channel.verifiedAt?.toISOString() ?? null,
    version: channel.version,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}
