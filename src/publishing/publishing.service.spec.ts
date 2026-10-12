/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicationStatus } from '../generated/prisma/client.js';
import { PublishingService } from './publishing.service.js';
import { TelegramPublicationError } from './telegram-publication.adapter.js';
import type { TelegramPublicationAdapter } from './telegram-publication.adapter.js';

function publication(status: PublicationStatus = PublicationStatus.READY) {
  return {
    id: 'publication-1',
    attemptCount: status === PublicationStatus.RETRY_WAIT ? 1 : 0,
    status,
    selectedVersion: { text: 'Hello from Autobot' },
    post: { userId: 'user-1', generateImage: false, channel: { telegramChatId: -100123n } },
  };
}

describe('PublishingService', () => {
  let prisma: {
    publication: {
      updateMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let adapter: TelegramPublicationAdapter;
  let sendText: ReturnType<typeof vi.fn>;
  let service: PublishingService;

  beforeEach(() => {
    prisma = {
      publication: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    };
    sendText = vi.fn();
    adapter = { sendText } as unknown as TelegramPublicationAdapter;
    service = new PublishingService(
      prisma as never,
      { get: vi.fn().mockReturnValue(5) } as never,
      adapter,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('publishes text and stores Telegram identifiers', async () => {
    prisma.publication.findUnique.mockResolvedValue(publication());
    sendText.mockResolvedValue({ chatId: -100123n, messageId: 77n });

    await service.publish('publication-1');

    expect(sendText).toHaveBeenCalledWith(-100123n, 'Hello from Autobot');
    expect(prisma.publication.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublicationStatus.PUBLISHED,
          telegramMessageId: 77n,
        }),
      }),
    );
  });

  it('moves retryable Telegram failures to RETRY_WAIT', async () => {
    prisma.publication.findUnique.mockResolvedValue(publication());
    sendText.mockRejectedValue(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 12),
    );

    await service.publish('publication-1');

    expect(prisma.publication.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublicationStatus.RETRY_WAIT,
          errorCode: 'TELEGRAM_RATE_LIMIT',
        }),
      }),
    );
  });

  it('does not retry an ambiguous Telegram response', async () => {
    prisma.publication.findUnique.mockResolvedValue(publication());
    sendText.mockRejectedValue(
      new TelegramPublicationError('TELEGRAM_DELIVERY_UNKNOWN', false, true),
    );

    await service.publish('publication-1');

    expect(prisma.publication.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PublicationStatus.DELIVERY_UNKNOWN }),
      }),
    );
  });
});
