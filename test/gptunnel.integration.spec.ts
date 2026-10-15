import { createHmac, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';

import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import { configureApplication } from '../src/bootstrap.js';
import { OutboxDispatcherService } from '../src/generation/outbox-dispatcher.service.js';
import { ImageTempService } from '../src/infrastructure/image-temp/image-temp.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { QUEUE_NAMES } from '../src/infrastructure/queue/queue.constants.js';
import { PublicationDispatcherService } from '../src/publishing/publishing-dispatcher.service.js';
import { SchedulerService } from '../src/schedules/scheduler.service.js';
import { cleanTestDatabase } from './support/test-database.js';

const secret = 'test-secret-32-bytes-long-1234567890';
const taskId = '6a61e021a6e77553a989c41d';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function headers(method: string, path: string, body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = canonicalBotRequest({
    method,
    originalUrl: path,
    body: Buffer.from(body),
    timestamp,
    nonce,
    telegramUserId: '99101',
  });
  return {
    'X-Autobot-Service': 'autobot-bot',
    'X-Autobot-Key-Id': 'test-key',
    'X-Autobot-Timestamp': timestamp,
    'X-Autobot-Nonce': nonce,
    'X-Autobot-Signature': `v1=${createHmac('sha256', secret).update(canonical).digest('hex')}`,
    'X-Telegram-User-Id': '99101',
  };
}

async function eventually(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The queue did not reach its expected durable state');
}

describe('GPTunnel publication pipeline over HTTP, PostgreSQL and BullMQ', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let generationQueue: Queue;
  let publicationQueue: Queue;
  let userId: string;
  let channelId: string;
  let textCalls = 0;
  let mediaCalls = 0;
  let telegramCalls = 0;
  let remainingTextFailures = 0;
  const mediaKeys: string[] = [];
  const downloadedAtUpload: Buffer[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (resource, options) => {
    const url =
      typeof resource === 'string'
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url;
    if (url.endsWith('/getChat'))
      return json({ ok: true, result: { id: -10099101, type: 'channel', title: 'Test channel' } });
    if (url.endsWith('/getMe'))
      return json({ ok: true, result: { id: 999, is_bot: true, first_name: 'Test' } });
    if (url.endsWith('/getChatMember'))
      return json({ ok: true, result: { status: 'administrator', can_post_messages: true } });
    if (url.endsWith('/chat/completions')) {
      textCalls++;
      if (remainingTextFailures > 0) {
        remainingTextFailures--;
        return json({ error: { message: 'DO_NOT_PERSIST' } }, 503);
      }
      return json({
        id: `chat-${textCalls}`,
        choices: [{ message: { content: 'Готовый пост для Telegram' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      });
    }
    if (url.includes('/media/models'))
      return json({ code: 0, models: [{ id: 'gpt-image', type: 'IMAGE', inputs: [] }] });
    if (url.endsWith('/media/tasks')) {
      mediaCalls++;
      if (typeof options?.body !== 'string') throw new Error('Expected JSON');
      const body = JSON.parse(options.body) as { idempotency_key: string };
      mediaKeys.push(body.idempotency_key);
      return json({ code: 0, id: taskId, status: 'running' });
    }
    if (url.endsWith(`/media/tasks/${taskId}`))
      return json({
        code: 0,
        id: taskId,
        status: 'done',
        result: [{ url: 'https://storage.example.test/result.png' }],
      });
    if (url === 'https://storage.example.test/result.png') return new Response(png);
    if (url.endsWith('/sendPhoto')) {
      telegramCalls++;
      const form = options?.body as FormData;
      const photo = form.get('photo') as File;
      downloadedAtUpload.push(Buffer.from(await photo.arrayBuffer()));
      return json({ ok: true, result: { message_id: telegramCalls, chat: { id: -10099101 } } });
    }
    if (url.endsWith('/sendMessage')) {
      telegramCalls++;
      return json({ ok: true, result: { message_id: telegramCalls, chat: { id: -10099101 } } });
    }
    throw new Error('Unexpected external request in pipeline test');
  });

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleReference.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const config = app.get(ConfigService);
    config.set('GPTUNNEL_API_KEY', 'fake-gptunnel-key');
    config.set('TELEGRAM_BOT_TOKEN', 'fake-telegram-token');
    config.set('AI_IMAGE_POLL_INTERVAL_MS', 100);
    // Disable periodic dispatch in this suite; dispatch explicitly through the real queues.
    config.set('OUTBOX_POLL_INTERVAL_MS', 600_000);
    config.set('SCHEDULER_POLL_INTERVAL_MS', 600_000);
    prisma = app.get(PrismaService);
    await prisma.$connect();
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    configureApplication(app, { swagger: false });
    generationQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.postGeneration));
    publicationQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.publication));
    await generationQueue.obliterate({ force: true });
    await publicationQueue.obliterate({ force: true });
    await app.init();
    app.get(OutboxDispatcherService).onModuleDestroy();
    app.get(PublicationDispatcherService).onModuleDestroy();
    app.get(SchedulerService).onModuleDestroy();
    generationQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.postGeneration));
    publicationQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.publication));
    const path = '/api/v1/internal/telegram-users/resolve';
    // The ordinary bot onboarding route uses the real signed REST boundary.
    const onboardingBody = JSON.stringify({ firstName: 'Test' });
    const onboard = await request(app.getHttpServer())
      .post(path)
      .set(headers('POST', path, onboardingBody))
      .set('Content-Type', 'application/json')
      .send(onboardingBody);
    expect([200, 201]).toContain(onboard.status);
    const user = await prisma.user.findFirstOrThrow({
      where: { telegramAccount: { telegramUserId: 99101n } },
    });
    userId = user.id;
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'pro' } });
    await prisma.subscription.create({
      data: { userId, planId: plan.id, status: 'ACTIVE', startsAt: new Date() },
    });
    const channel = await post('/api/v1/channels', { telegramChatId: '-10099101' }).expect(201);
    channelId = (channel.body as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    if (app) {
      await generationQueue?.drain();
      await publicationQueue?.drain();
      await app.close();
    }
    vi.unstubAllGlobals();
  });

  function post(path: string, payload?: unknown) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const result = request(app.getHttpServer())
      .post(path)
      .set(headers('POST', path, body))
      .set('Idempotency-Key', randomUUID());
    return body ? result.set('Content-Type', 'application/json').send(body) : result;
  }

  async function create(publicationMode: 'AUTO' | 'MODERATION', generateImage: boolean) {
    const created = await post('/api/v1/posts', {
      channelId,
      prompt: 'Расскажи о космосе',
      publicationMode,
      generateImage,
    }).expect(201);
    const postId = (created.body as { data: { id: string } }).data.id;
    const occurrence = await post(`/api/v1/posts/${postId}/publications`)
      .set('If-Match', '"1"')
      .expect(202);
    return (occurrence.body as { data: { id: string } }).data.id;
  }

  async function status(id: string, expected: string) {
    return (await prisma.publication.findUniqueOrThrow({ where: { id } })).status === expected;
  }

  it('retries a transient text error through BullMQ without duplicating versions or usage, then publishes once', async () => {
    remainingTextFailures = 1;
    const id = await create('AUTO', false);
    await app.get(OutboxDispatcherService).dispatchPending();
    await eventually(() => status(id, 'READY'));
    expect(textCalls).toBe(2);
    expect(await prisma.postVersion.count({ where: { publicationId: id } })).toBe(1);
    expect(await prisma.aIRequest.count({ where: { publicationId: id } })).toBe(1);
    expect(await prisma.aIRequest.findFirstOrThrow({ where: { publicationId: id } })).toMatchObject(
      { provider: 'gptunnel', status: 'SUCCEEDED', inputUnits: 50, outputUnits: 12 },
    );
    await app.get(PublicationDispatcherService).dispatchDue();
    await eventually(() => status(id, 'PUBLISHED'));
    await app.get(PublicationDispatcherService).dispatchDue();
    expect(telegramCalls).toBe(1);
    const counter = await prisma.usageCounter.findFirstOrThrow({
      where: { userId, metric: 'TEXT_GENERATION' },
    });
    expect(counter).toMatchObject({ committed: 1, reserved: 0 });
    const rows = await prisma.aIRequest.findMany({ where: { publicationId: id } });
    expect(JSON.stringify(rows)).not.toContain('DO_NOT_PERSIST');
  });

  it('waits for moderation approval before creating an image and deletes the uploaded file', async () => {
    const id = await create('MODERATION', true);
    await app.get(OutboxDispatcherService).dispatchPending();
    await eventually(() => status(id, 'AWAITING_MODERATION'));
    expect(mediaCalls).toBe(0);
    const moderation = await prisma.moderationRequest.findFirstOrThrow({
      where: { publicationId: id },
    });
    await post(`/api/v1/moderation/${moderation.id}/approve`).set('If-Match', '"1"').expect(202);
    await app.get(PublicationDispatcherService).dispatchDue();
    await eventually(() => status(id, 'PUBLISHED'));
    // The durable success update precedes the finally cleanup by a few microtasks.
    const directory = app.get(ImageTempService).directory;
    await eventually(async () => (await readdir(directory)).length === 0);
    expect(downloadedAtUpload).toEqual([png]);
    expect(mediaCalls).toBe(1);
    expect(mediaKeys).toEqual([`publication:${id}:image`]);
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id } });
    expect(publication).toMatchObject({ publishedWithImage: true, telegramMessageId: 2n });
    expect(
      JSON.stringify(publication, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('storage.example.test');
    const counter = await prisma.usageCounter.findFirstOrThrow({
      where: { userId, metric: 'IMAGE_GENERATION' },
    });
    expect(counter).toMatchObject({ committed: 1, reserved: 0 });
  });

  it('records terminal failure and releases text/image reservations after exhausting provider retries', async () => {
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 2);
    remainingTextFailures = 2;
    const id = await create('AUTO', true);
    await app.get(OutboxDispatcherService).dispatchPending();
    await eventually(() => status(id, 'FAILED'));
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
      errorCode: 'AI_PROVIDER_HTTP_503',
    });
    expect(await prisma.postVersion.count({ where: { publicationId: id } })).toBe(1);
    expect(await prisma.aIRequest.findFirstOrThrow({ where: { publicationId: id } })).toMatchObject(
      { provider: 'gptunnel', status: 'FAILED' },
    );
    expect(
      await prisma.usageCounter.findFirstOrThrow({ where: { userId, metric: 'TEXT_GENERATION' } }),
    ).toMatchObject({ committed: 2, reserved: 0 });
    expect(
      await prisma.usageCounter.findFirstOrThrow({ where: { userId, metric: 'IMAGE_GENERATION' } }),
    ).toMatchObject({ committed: 1, reserved: 0 });
    expect(mediaCalls).toBe(1);
  });
});
