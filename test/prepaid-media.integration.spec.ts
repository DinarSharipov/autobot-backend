import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/bootstrap.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { ImageTempService } from '../src/infrastructure/image-temp/image-temp.service.js';
import { IdentityService } from '../src/users/identity.service.js';
import type { MediaJob } from '../src/publishing/publication-media-dispatcher.service.js';
import { PrepaidTextService } from '../src/generation-packs/prepaid-text.service.js';
import { WalletService } from '../src/generation-packs/wallet.service.js';
import { GenerationService } from '../src/generation/generation.service.js';
import { TextGenerationAdapter } from '../src/generation/text-generation.adapter.js';
import {
  ImageGenerationAdapter,
  ImageGenerationProviderError,
} from '../src/publishing/image-generation.adapter.js';
import {
  TelegramPublicationAdapter,
  TelegramPublicationError,
} from '../src/publishing/telegram-publication.adapter.js';
import { PublicationMediaService } from '../src/publishing/publication-media.service.js';
import { PublishingService } from '../src/publishing/publishing.service.js';
import { ModerationService } from '../src/moderation/moderation.service.js';
import { withoutBackgroundJobs } from './support/without-background-jobs.js';
import { cleanTestDatabase } from './support/test-database.js';

describe('prepaid media generation, preview, selection and delivery', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let media: PublicationMediaService;
  let wallet: WalletService;
  let publicationId: string;
  let userId: string;
  let uploadSequence = 0;
  const paths: string[] = [];
  const images = { generate: vi.fn() };
  const telegram = {
    sendText: vi.fn(),
    sendPhoto: vi.fn(),
    uploadPhoto: vi.fn(),
    sendPhotoByFileId: vi.fn(),
  };
  const text = { generate: vi.fn() };
  beforeAll(async () => {
    const module = await withoutBackgroundJobs(Test.createTestingModule({ imports: [AppModule] }))
      .overrideProvider(ImageGenerationAdapter)
      .useValue(images)
      .overrideProvider(TextGenerationAdapter)
      .useValue(text)
      .overrideProvider(TelegramPublicationAdapter)
      .useValue(telegram)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApplication(app, { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);
    media = app.get(PublicationMediaService);
    wallet = app.get(WalletService);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', true);
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 3);
    paths.length = 0;
    uploadSequence = 0;
    images.generate.mockReset().mockImplementation(imageFile);
    text.generate.mockReset().mockResolvedValue({
      text: 'Generated post',
      providerRequestId: 'text-request',
      inputUnits: 1,
      outputUnits: 1,
    });
    telegram.sendText.mockReset();
    telegram.sendPhoto.mockReset();
    telegram.uploadPhoto.mockReset().mockImplementation(() => {
      uploadSequence++;
      return Promise.resolve({
        chatId: BigInt(1234567),
        messageId: BigInt(uploadSequence),
        fileId: `file-${uploadSequence}`,
        fileUniqueId: `unique-${uploadSequence}`,
      });
    });
    telegram.sendPhotoByFileId
      .mockReset()
      .mockResolvedValue({ chatId: BigInt(-100123), messageId: BigInt(999) });
    const user = await app.get(IdentityService).resolveBotUser({ telegramUserId: '1234567' });
    userId = user.id;
    const channel = await prisma.channel.create({
      data: { userId, telegramChatId: BigInt(-100123), title: 'Test channel', status: 'ACTIVE' },
    });
    const post = await prisma.post.create({
      data: {
        userId,
        channelId: channel.id,
        prompt: 'Illustrated post',
        publicationMode: 'MODERATION',
        generateImage: true,
      },
    });
    const publication = await prisma.publication.create({
      data: { postId: post.id, fundingMode: 'PREPAID', scheduledFor: new Date() },
    });
    publicationId = publication.id;
    for (const creditType of ['TEXT', 'IMAGE'] as const)
      await wallet.grant({
        userId,
        creditType,
        units: 3,
        kind: 'GIFT',
        operationKey: randomUUID(),
      });
  });
  afterEach(async () => {
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  });
  afterAll(async () => app.close());
  async function imageFile() {
    const filePath = await app
      .get(ImageTempService)
      .createFile(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    paths.push(filePath);
    return { filePath };
  }
  function pub() {
    return prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
  }
  function balance() {
    return prisma.generationWallet.findUniqueOrThrow({
      where: { userId_creditType: { userId, creditType: 'IMAGE' } },
    });
  }
  async function initial(mode: 'MODERATION' | 'AUTO' = 'MODERATION') {
    const original = await pub();
    await prisma.post.update({ where: { id: original.postId }, data: { publicationMode: mode } });
    await app.get(GenerationService).generate(publicationId);
    return prisma.publicationMedia.findFirstOrThrow({ where: { publicationId } });
  }
  async function selected() {
    const row = await initial();
    await media.process(row.id);
    await media.select(userId, publicationId, row.id, (await pub()).version, false, randomUUID());
    return row;
  }
  async function replacement() {
    const quote = await media.preview(userId, publicationId);
    return media.request(
      userId,
      publicationId,
      quote.publicationVersion,
      quote.costConfirmationId,
      randomUUID(),
    );
  }
  async function approve() {
    const mod = await prisma.moderationRequest.findFirstOrThrow({
      where: { publicationId, status: 'PENDING' },
    });
    return app.get(ModerationService).approve(userId, mod.id, mod.version, randomUUID());
  }
  function signed(
    path: string,
    body?: unknown,
    version?: number,
    key = randomUUID(),
    telegramId = '1234567',
    method: 'GET' | 'POST' = 'POST',
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const canonical = canonicalBotRequest({
      method,
      originalUrl: path,
      body: Buffer.from(raw),
      timestamp,
      nonce,
      telegramUserId: telegramId,
    });
    const call = request(app.getHttpServer())
      [method === 'GET' ? 'get' : 'post'](path)
      .set({
        'X-Autobot-Service': 'autobot-bot',
        'X-Autobot-Key-Id': 'test-key',
        'X-Autobot-Timestamp': timestamp,
        'X-Autobot-Nonce': nonce,
        'X-Autobot-Signature': `v1=${createHmac('sha256', 'test-secret-32-bytes-long-1234567890').update(canonical).digest('hex')}`,
        'X-Telegram-User-Id': telegramId,
        'Idempotency-Key': key,
      });
    if (version) call.set('If-Match', `"${version}"`);
    return body === undefined ? call : call.set('Content-Type', 'application/json').send(raw);
  }

  it('uploads a private preview, requires selection and reuses exactly that file on delivery retry', async () => {
    const row = await initial();
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
    await media.process(row.id);
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
    expect(telegram.uploadPhoto).toHaveBeenCalledWith(
      BigInt(1234567),
      expect.any(String),
      paths[0],
    );
    await expect(approve()).rejects.toMatchObject({ response: { code: 'MEDIA_UNAVAILABLE' } });
    const listing = await signed(
      `/api/v1/publications/${publicationId}/media`,
      undefined,
      undefined,
      randomUUID(),
      '1234567',
      'GET',
    ).expect(200);
    expect(listing.body).toMatchObject({
      data: { selectedMediaId: null, items: [{ telegramFileId: 'file-1', status: 'READY' }] },
    });
    await signed(
      `/api/v1/publications/${publicationId}/media/${row.id}/select`,
      { keepOutdated: false },
      (await pub()).version,
    ).expect(200);
    await approve();
    telegram.sendPhotoByFileId.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 1),
    );
    await app.get(PublishingService).publish(publicationId);
    await prisma.publication.update({
      where: { id: publicationId },
      data: { nextAttemptAt: new Date(0) },
    });
    await app.get(PublishingService).publish(publicationId);
    expect((await pub()).status).toBe('PUBLISHED');
    expect(telegram.sendPhotoByFileId.mock.calls).toEqual([
      [BigInt(-100123), 'Generated post', 'file-1'],
      [BigInt(-100123), 'Generated post', 'file-1'],
    ]);
    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(telegram.sendPhoto).not.toHaveBeenCalled();
    expect(
      await prisma.creditLedgerEntry.count({
        where: { publicationId, kind: 'COMMIT', wallet: { creditType: 'IMAGE' } },
      }),
    ).toBe(1);
  });

  it('charges each accepted replacement once and replays the creation key', async () => {
    await selected();
    const preview = await signed(`/api/v1/publications/${publicationId}/media/cost-preview`).expect(
      200,
    );
    const quote = (
      preview.body as {
        data: { publicationVersion: number; costConfirmationId: string; units: number };
      }
    ).data;
    expect(quote.units).toBe(1);
    const key = randomUUID();
    const body = { costConfirmationId: quote.costConfirmationId };
    const first = await signed(
      `/api/v1/publications/${publicationId}/media`,
      body,
      quote.publicationVersion,
      key,
    ).expect(202);
    const replay = await signed(
      `/api/v1/publications/${publicationId}/media`,
      body,
      quote.publicationVersion,
      key,
    ).expect(202);
    expect(replay.body).toEqual(first.body);
    const id = (first.body as { data: { id: string } }).data.id;
    await Promise.all([media.process(id), media.process(id)]);
    await media.select(userId, publicationId, id, (await pub()).version, false, randomUUID());
    await approve();
    await app.get(PublishingService).publish(publicationId);
    expect(telegram.sendPhotoByFileId).toHaveBeenCalledWith(
      BigInt(-100123),
      'Generated post',
      'file-2',
    );
    expect(images.generate).toHaveBeenCalledTimes(2);
    expect(await balance()).toMatchObject({ available: 1, reserved: 0 });
  });

  it('marks an image outdated after text revision and requires an explicit keep without another image debit', async () => {
    const row = await selected();
    const staleVersion = (await pub()).version;
    const mod = await prisma.moderationRequest.findFirstOrThrow({
      where: { publicationId, status: 'PENDING' },
    });
    await app
      .get(ModerationService)
      .requestRevision(userId, mod.id, mod.version, 'Rewrite opening', randomUUID());
    await app.get(GenerationService).generate(publicationId);
    expect((await media.list(userId, publicationId)).items[0]).toMatchObject({
      isOutdated: true,
      selectionIsCurrent: false,
    });
    await expect(approve()).rejects.toMatchObject({ response: { code: 'MEDIA_UNAVAILABLE' } });
    await expect(
      media.select(userId, publicationId, row.id, staleVersion, true, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'STALE_RESOURCE_VERSION' } });
    await expect(
      media.select(userId, publicationId, row.id, (await pub()).version, false, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_OUTDATED' } });
    await media.select(userId, publicationId, row.id, (await pub()).version, true, randomUUID());
    await approve();
    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
  });

  it('blocks IMAGE funds before a provider call and resumes the same approved operation idempotently', async () => {
    const row = await initial();
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'IMAGE' },
      data: { available: 0 },
    });
    await media.process(row.id);
    await media.process(row.id);
    expect(images.generate).not.toHaveBeenCalled();
    expect(await pub()).toMatchObject({
      fundingStatus: 'BLOCKED_FUNDS',
      errorCode: 'INSUFFICIENT_IMAGE_CREDITS',
    });
    await wallet.grant({
      userId,
      creditType: 'IMAGE',
      units: 1,
      kind: 'PURCHASE',
      operationKey: randomUUID(),
    });
    const path = `/api/v1/publications/${publicationId}/media/${row.id}/resume`;
    const key = randomUUID();
    const first = await signed(path, undefined, undefined, key).expect(202);
    const replay = await signed(path, undefined, undefined, key).expect(202);
    expect(replay.body).toEqual(first.body);
    await media.process(row.id);
    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(images.generate.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: row.generationOperationKey,
    });
    expect(await balance()).toMatchObject({ available: 0, reserved: 0 });
    expect(await prisma.publicationMedia.count({ where: { publicationId } })).toBe(1);
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 2 });
  });

  it('keeps an existing selected image usable when an unfunded replacement is rejected', async () => {
    const old = await selected();
    const next = await replacement();
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'IMAGE' },
      data: { available: 0 },
    });
    await media.process(next.id);
    expect((await pub()).fundingStatus).toBe('READY');
    await media.reject(userId, publicationId, next.id, (await pub()).version, randomUUID());
    await approve();
    expect((await pub()).selectedMediaId).toBe(old.id);
  });

  it('releases terminal provider failure and uses a new key only on an explicitly purchased replacement', async () => {
    const row = await initial();
    images.generate.mockRejectedValueOnce(
      new ImageGenerationProviderError('AI_IMAGE_REJECTED', false),
    );
    await media.process(row.id);
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
    expect(telegram.uploadPhoto).not.toHaveBeenCalled();
    const next = await replacement();
    await media.process(next.id);
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
    expect(images.generate.mock.calls[0]?.[0]).not.toEqual(images.generate.mock.calls[1]?.[0]);
  });

  it.each(['provider', 'upload'] as const)(
    'retries %s failure under the same operation and charges once',
    async (phase) => {
      const row = await initial();
      if (phase === 'provider')
        images.generate.mockRejectedValueOnce(
          new ImageGenerationProviderError('AI_IMAGE_PROVIDER_TIMEOUT', true),
        );
      else
        telegram.uploadPhoto.mockRejectedValueOnce(
          new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 1),
        );
      await media.process(row.id);
      expect(await balance()).toMatchObject({ available: 2, reserved: 1 });
      await prisma.publicationMedia.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await media.process(row.id);
      expect(images.generate.mock.calls[0]).toEqual(images.generate.mock.calls[1]);
      expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
      expect(
        await prisma.creditLedgerEntry.count({
          where: { reservation: { operationKey: row.generationOperationKey! }, kind: 'COMMIT' },
        }),
      ).toBe(1);
    },
  );

  it('stops ambiguous upload without repeating it or charging an unusable artifact', async () => {
    const row = await initial();
    telegram.uploadPhoto.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_DELIVERY_UNKNOWN', false, true),
    );
    await media.process(row.id);
    await media.process(row.id);
    expect(
      await prisma.publicationMedia.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ generationStatus: 'UPLOAD_UNKNOWN', status: 'UNAVAILABLE' });
    expect(telegram.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
  });

  it('does not repeat an upload when persisting its accepted result failed', async () => {
    const row = await initial();
    const commit = vi.spyOn(wallet, 'commit').mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(media.process(row.id)).rejects.toThrow('DB unavailable');
    commit.mockRestore();
    expect(
      await prisma.publicationMedia.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ generationStatus: 'UPLOADING', telegramFileId: null });
    await prisma.publicationMedia.update({
      where: { id: row.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await media.process(row.id);
    expect(telegram.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
  });

  it('fences an expired generation worker so only the recovery worker uploads and commits', async () => {
    const row = await initial();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    images.generate.mockImplementationOnce(async () => {
      started();
      await waiting;
      return imageFile();
    });
    const oldWorker = media.process(row.id);
    await ready;
    await prisma.publicationMedia.update({
      where: { id: row.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await media.process(row.id);
    release();
    await oldWorker;
    expect(telegram.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
  });

  it('cancels running generation before upload and returns the held credit', async () => {
    const row = await initial();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    images.generate.mockImplementationOnce(async () => {
      started();
      await waiting;
      return imageFile();
    });
    const worker = media.process(row.id);
    await ready;
    await app.get(PublishingService).cancel(userId, publicationId, randomUUID());
    release();
    await worker;
    expect(telegram.uploadPhoto).not.toHaveBeenCalled();
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
    expect((await pub()).status).toBe('CANCELLED');
  });

  it('allows only one concurrent image generation to spend the last IMAGE credit', async () => {
    const first = await initial();
    const original = await pub();
    const secondPub = await prisma.publication.create({
      data: { postId: original.postId, fundingMode: 'PREPAID', scheduledFor: new Date() },
    });
    await app.get(GenerationService).generate(secondPub.id);
    const second = await prisma.publicationMedia.findFirstOrThrow({
      where: { publicationId: secondPub.id },
    });
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'IMAGE' },
      data: { available: 1 },
    });
    await Promise.all([media.process(first.id), media.process(second.id)]);
    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(
      await prisma.publicationMedia.count({ where: { generationStatus: 'BLOCKED_FUNDS' } }),
    ).toBe(1);
    expect(await balance()).toMatchObject({ available: 0, reserved: 0 });
  });

  it('selects the initial image automatically in AUTO mode and never regenerates at delivery', async () => {
    const row = await initial('AUTO');
    expect((await pub()).status).toBe('AWAITING_MEDIA');
    await media.process(row.id);
    expect(await pub()).toMatchObject({ status: 'READY', selectedMediaId: row.id });
    await app.get(PublishingService).publish(publicationId);
    expect((await pub()).status).toBe('PUBLISHED');
    expect(images.generate).toHaveBeenCalledTimes(1);
  });

  it('reports a lost Telegram file without repurchasing it and supports explicit recovery', async () => {
    await selected();
    await approve();
    telegram.sendPhotoByFileId.mockRejectedValueOnce(
      new TelegramPublicationError('MEDIA_UNAVAILABLE', false, false),
    );
    await app.get(PublishingService).publish(publicationId);
    expect((await pub()).errorCode).toBe('MEDIA_UNAVAILABLE');
    expect(images.generate).toHaveBeenCalledTimes(1);
    const next = await replacement();
    await media.process(next.id);
    await media.select(userId, publicationId, next.id, (await pub()).version, false, randomUUID());
    await app.get(PublishingService).publish(publicationId);
    expect((await pub()).status).toBe('PUBLISHED');
    expect(await balance()).toMatchObject({ available: 1, reserved: 0 });
  });

  it('does not refund a successfully generated preview when rejected', async () => {
    const row = await initial();
    await media.process(row.id);
    await media.reject(userId, publicationId, row.id, (await pub()).version, randomUUID());
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
    await expect(
      media.select(userId, publicationId, row.id, (await pub()).version, false, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_UNAVAILABLE' } });
  });

  it.each(['expired', 'changed', 'foreign'] as const)(
    'rejects a %s replacement quote without reserving credits',
    async (reason) => {
      await selected();
      const quote = await media.preview(userId, publicationId);
      if (reason === 'expired')
        await prisma.mediaCostConfirmation.update({
          where: { id: quote.costConfirmationId },
          data: { expiresAt: new Date(0) },
        });
      if (reason === 'changed')
        await prisma.mediaCostConfirmation.update({
          where: { id: quote.costConfirmationId },
          data: { publicationVersion: quote.publicationVersion - 1 },
        });
      if (reason === 'foreign') {
        const other = await prisma.user.create({ data: {} });
        await prisma.mediaCostConfirmation.update({
          where: { id: quote.costConfirmationId },
          data: { userId: other.id },
        });
      }
      await expect(
        media.request(
          userId,
          publicationId,
          quote.publicationVersion,
          quote.costConfirmationId,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ response: { code: 'STALE_COST_CONFIRMATION' } });
      expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
    },
  );

  it('enforces ownership and authentication on every media route', async () => {
    const row = await initial();
    await app.get(IdentityService).resolveBotUser({ telegramUserId: '7654321' });
    const base = `/api/v1/publications/${publicationId}/media`;
    const operations: [string, 'GET' | 'POST', unknown][] = [
      [base, 'GET', undefined],
      [`${base}/cost-preview`, 'POST', undefined],
      [base, 'POST', { costConfirmationId: randomUUID() }],
      [`${base}/${row.id}/select`, 'POST', { keepOutdated: false }],
      [`${base}/${row.id}/reject`, 'POST', undefined],
      [`${base}/${row.id}/resume`, 'POST', undefined],
    ];
    for (const [path, method, body] of operations) {
      await signed(path, body, (await pub()).version, randomUUID(), '7654321', method).expect(404);
      await request(app.getHttpServer())[method === 'GET' ? 'get' : 'post'](path).expect(401);
    }
  });
  it('keeps accepted generation charged and refuses cancellation while upload is in flight', async () => {
    const row = await initial();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    telegram.uploadPhoto.mockImplementationOnce(async () => {
      started();
      await waiting;
      return {
        chatId: BigInt(1234567),
        messageId: BigInt(99),
        fileId: 'file-held',
        fileUniqueId: 'unique-held',
      };
    });
    const worker = media.process(row.id);
    await ready;
    await expect(
      app.get(PublishingService).cancel(userId, publicationId, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_GENERATION_IN_PROGRESS' } });
    release();
    await worker;
    expect(await balance()).toMatchObject({ available: 2, reserved: 0 });
    expect(
      await prisma.aIRequest.findFirstOrThrow({ where: { publicationId, kind: 'IMAGE' } }),
    ).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('stops retrying and releases the reservation after the configured attempt limit', async () => {
    const row = await initial();
    images.generate.mockRejectedValue(
      new ImageGenerationProviderError('AI_IMAGE_PROVIDER_TIMEOUT', true),
    );
    for (let i = 0; i < 3; i++) {
      await prisma.publicationMedia.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await media.process(row.id);
    }
    await media.process(row.id);
    expect(images.generate).toHaveBeenCalledTimes(3);
    expect(await balance()).toMatchObject({ available: 3, reserved: 0 });
    expect(
      await prisma.aIRequest.findFirstOrThrow({ where: { publicationId, kind: 'IMAGE' } }),
    ).toMatchObject({ status: 'FAILED' });
    expect(await prisma.aIRequest.count({ where: { publicationId, kind: 'IMAGE' } })).toBe(1);
  });

  it('dispatches durable media work with a valid BullMQ job identifier', async () => {
    const { Queue } = await import('bullmq');
    const { PublicationMediaDispatcher } =
      await import('../src/publishing/publication-media-dispatcher.service.js');
    const redis = new URL(process.env.AUTOBOT_TEST_REDIS_URL ?? 'redis://localhost:6380/15');
    const queue = new Queue<MediaJob>(`media-integration-${randomUUID()}`, {
      connection: {
        host: redis.hostname,
        port: Number(redis.port),
        db: Number(redis.pathname.slice(1)),
      },
    });
    try {
      await initial();
      const dispatcher = new PublicationMediaDispatcher(prisma, app.get(ConfigService), queue);
      await dispatcher.dispatch();
      await dispatcher.dispatch();
      expect(await queue.getWaitingCount()).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('checks media schema rollback without deleting funded work', async () => {
    const sql = await readFile(
      new URL('../prisma/rollback/20261020180000_prepaid_media.sql', import.meta.url),
      'utf8',
    );
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(sql)).rejects.toThrow('Prepaid publications exist');
      await client.query('ROLLBACK');
      await prisma.publication.update({
        where: { id: publicationId },
        data: { fundingMode: 'LEGACY' },
      });
      await client.query('BEGIN');
      await client.query(sql);
      const check = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PublicationMedia' AND column_name = 'generationStatus') AS present`,
      );
      expect(check.rows[0]?.present).toBe(false);
      await client.query('ROLLBACK');
      expect(await prisma.publicationMedia.count()).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
  it.each(['success', 'failure'] as const)(
    'preserves an unrelated TEXT funds block when in-flight media ends with %s',
    async (outcome) => {
      const row = await initial();
      for (let i = 0; i < 3; i++) {
        const source = await prisma.moderationRequest.findFirstOrThrow({
          where: { publicationId, status: 'PENDING' },
        });
        await app
          .get(ModerationService)
          .requestRevision(userId, source.id, source.version, 'Revise text', randomUUID());
        await app.get(GenerationService).generate(publicationId);
      }
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      images.generate.mockImplementationOnce(async () => {
        started();
        await waiting;
        if (outcome === 'failure')
          throw new ImageGenerationProviderError('AI_IMAGE_REJECTED', false);
        return imageFile();
      });
      const worker = media.process(row.id);
      await ready;
      await prisma.generationWallet.updateMany({
        where: { userId, creditType: 'TEXT' },
        data: { available: 0 },
      });
      const quote = await app.get(PrepaidTextService).preview(userId, publicationId);
      await app
        .get(ModerationService)
        .requestRevision(
          userId,
          quote.moderationRequestId,
          quote.moderationVersion,
          'Paid change',
          randomUUID(),
          quote.costConfirmationId,
        );
      await app.get(GenerationService).generate(publicationId);
      release();
      await worker;
      expect(await pub()).toMatchObject({
        status: 'PENDING',
        fundingStatus: 'BLOCKED_FUNDS',
        errorCode: 'INSUFFICIENT_TEXT_CREDITS',
      });
      expect(await balance()).toMatchObject({
        available: outcome === 'success' ? 2 : 3,
        reserved: 0,
      });
    },
  );
  it('invalidates preview callbacks and quotes when moderation approves the selected content', async () => {
    const selectedImage = await selected();
    const next = await replacement();
    await media.process(next.id);
    const oldVersion = (await pub()).version;
    const oldQuote = await media.preview(userId, publicationId);
    await approve();
    await expect(
      media.select(userId, publicationId, next.id, oldVersion, false, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'STALE_RESOURCE_VERSION' } });
    await expect(
      media.request(
        userId,
        publicationId,
        (await pub()).version,
        oldQuote.costConfirmationId,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ response: { code: 'STALE_COST_CONFIRMATION' } });
    expect((await pub()).selectedMediaId).toBe(selectedImage.id);
  });
  it('invalidates an old READY cost quote when channel delivery has started', async () => {
    const row = await initial('AUTO');
    await media.process(row.id);
    const quote = await media.preview(userId, publicationId);
    telegram.sendPhotoByFileId.mockRejectedValueOnce(
      new TelegramPublicationError('MEDIA_UNAVAILABLE', false, false),
    );
    await app.get(PublishingService).publish(publicationId);
    await expect(
      media.request(
        userId,
        publicationId,
        (await pub()).version,
        quote.costConfirmationId,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ response: { code: 'STALE_COST_CONFIRMATION' } });
    expect(images.generate).toHaveBeenCalledTimes(1);
  });
});
