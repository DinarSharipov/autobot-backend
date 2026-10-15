/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicationStatus } from '../generated/prisma/client.js';
import { PublishingService } from './publishing.service.js';
import { TelegramPublicationError } from './telegram-publication.adapter.js';
import type { TelegramPublicationAdapter } from './telegram-publication.adapter.js';
import { ImageGenerationProviderError } from './image-generation.adapter.js';

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
  let sendPhoto: ReturnType<typeof vi.fn>;
  let generateImage: ReturnType<typeof vi.fn>;
  let removeImage: ReturnType<typeof vi.fn>;
  let commitUsage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    prisma = {
      publication: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    };
    sendText = vi.fn();
    sendPhoto = vi.fn();
    generateImage = vi.fn().mockResolvedValue({ filePath: '/tmp/test-image.png' });
    removeImage = vi.fn().mockResolvedValue(undefined);
    commitUsage = vi.fn().mockResolvedValue(undefined);
    adapter = { sendText, sendPhoto } as unknown as TelegramPublicationAdapter;
    service = new PublishingService(
      prisma as never,
      { get: vi.fn().mockReturnValue(5) } as never,
      adapter,
      { generate: generateImage } as never,
      { remove: removeImage } as never,
      {} as never,
      { commit: commitUsage } as never,
    );
  });

  it.each([
    [
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 12),
      PublicationStatus.RETRY_WAIT,
    ],
    [
      new TelegramPublicationError('TELEGRAM_DELIVERY_UNKNOWN', false, true),
      PublicationStatus.DELIVERY_UNKNOWN,
    ],
  ])('deletes the generated image when Telegram fails: %s', async (error, status) => {
    const row = publication();
    row.post.generateImage = true;
    prisma.publication.findUnique.mockResolvedValue(row);
    sendPhoto.mockRejectedValue(error);

    await service.publish(row.id);

    expect(removeImage).toHaveBeenCalledExactlyOnceWith('/tmp/test-image.png');
    expect(commitUsage).toHaveBeenCalledTimes(1);
    expect(prisma.publication.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status }) }),
    );
  });

  it('uses the image provider Retry-After delay without creating a temporary file', async () => {
    const row = publication();
    row.post.generateImage = true;
    prisma.publication.findUnique.mockResolvedValue(row);
    generateImage.mockRejectedValue(
      new ImageGenerationProviderError('AI_PROVIDER_RATE_LIMITED', true, 60),
    );
    const before = Date.now();

    await service.publish(row.id);

    const update = prisma.publication.updateMany.mock.calls.at(-1)?.[0] as {
      data: { nextAttemptAt: Date };
    };
    expect(update.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(commitUsage).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
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
