import { TelegramBotApiChannelAdapter } from '../../src/channels/telegram-channel.adapter.js';
import type { MockInstance } from 'vitest';
import { MetricsService } from '../../src/common/observability/metrics.service.js';
import { GptunnelTextGenerationAdapter } from '../../src/generation/gptunnel-text-generation.adapter.js';
import { GptunnelClient } from '../../src/infrastructure/gptunnel/gptunnel.client.js';
import { Queue } from 'bullmq';
import type { PostGenerationJobPayload } from '../../src/infrastructure/queue/job-contracts.js';
import type { Request } from 'express';
import type { AppEnvironment } from '../../src/config/environment.js';

import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import { BotRequestSignatureService } from '../../src/auth/bot-request-signature.service.js';

import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { canonicalBotRequest } from '../../src/auth/bot-request-signature.service.js';
import { configureApplication } from '../../src/bootstrap.js';
import { TelegramChannelAdapter } from '../../src/channels/telegram-channel.adapter.js';
import type { PublicationStatus } from '../../src/generated/prisma/client.js';
import { GenerationService } from '../../src/generation/generation.service.js';
import { OutboxDispatcherService } from '../../src/generation/outbox-dispatcher.service.js';
import { TextGenerationAdapter } from '../../src/generation/text-generation.adapter.js';
import { ImageTempService } from '../../src/infrastructure/image-temp/image-temp.service.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  ImageGenerationAdapter,
  ImageGenerationProviderError,
} from '../../src/publishing/image-generation.adapter.js';
import { PublicationDispatcherService } from '../../src/publishing/publishing-dispatcher.service.js';
import { PublishingService } from '../../src/publishing/publishing.service.js';
import {
  TelegramPublicationAdapter,
  TelegramPublicationError,
} from '../../src/publishing/telegram-publication.adapter.js';
import { SchedulerService } from '../../src/schedules/scheduler.service.js';
import { SchedulesService } from '../../src/schedules/schedules.service.js';
import { PlanProvisioningService } from '../../src/subscriptions/plan-provisioning.service.js';
import { UsageService } from '../../src/subscriptions/usage.service.js';
import { EntitlementService } from '../../src/subscriptions/entitlement.service.js';
import { TextGenerationProviderError } from '../../src/generation/text-generation.adapter.js';
import { IdentityService } from '../../src/users/identity.service.js';
import { cleanTestDatabase } from '../support/test-database.js';

const secret = 'test-secret-32-bytes-long-1234567890';
const catalog = await readFile(new URL('../../docs/TEST_CASES.md', import.meta.url), 'utf8');
// Resolve the catalogue independently of the process working directory.
const catalogRows = catalog
  .split('\n')
  .filter((line) => /^\| TC-/.test(line))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

function headers(method: string, path: string, body: string, telegramUserId = '910001') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret)
    .update(
      canonicalBotRequest({
        method,
        originalUrl: path,
        body: Buffer.from(body),
        timestamp,
        nonce,
        telegramUserId,
      }),
    )
    .digest('hex');
  return {
    'X-Autobot-Service': 'autobot-bot',
    'X-Autobot-Key-Id': 'test-key',
    'X-Autobot-Timestamp': timestamp,
    'X-Autobot-Nonce': nonce,
    'X-Autobot-Signature': `v1=${signature}`,
    'X-Telegram-User-Id': telegramUserId,
  };
}

describe('Catalogue acceptance on disposable PostgreSQL/Redis with mocked external side effects', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let usage: UsageService;
  let a: string;
  let b: string;
  let channelA: string;
  let channelB: string;
  let topicA: string;
  let topicB: string;
  let postA: string;
  let postB: string;
  let publicationA: string;
  let publicationB: string;
  let scheduleB: string;
  let moderationB: string;
  const text = vi.fn<TextGenerationAdapter['generate']>().mockResolvedValue({
    text: 'Test final artifact',
    providerRequestId: 'test-provider-id',
    inputUnits: 4,
    outputUnits: 4,
  });
  const sendText = vi.fn().mockResolvedValue({ chatId: -100111n, messageId: 10n });
  const sendPhoto = vi.fn().mockResolvedValue({ chatId: -100111n, messageId: 11n });
  const generateImage = vi.fn();
  const validateChannel = vi.fn<TelegramChannelAdapter['validate']>((telegramChatId: bigint) =>
    Promise.resolve({
      telegramChatId,
      title: 'Acceptance channel',
      username: null,
      botPermissions: { status: 'administrator', canPostMessages: true },
    }),
  );

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('External HTTP is forbidden in acceptance')),
    );
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TelegramChannelAdapter)
      .useValue({ validate: validateChannel })
      .overrideProvider(TextGenerationAdapter)
      .useValue({ generate: text })
      .overrideProvider(TelegramPublicationAdapter)
      .useValue({ sendText, sendPhoto })
      .overrideProvider(ImageGenerationAdapter)
      .useValue({ generate: generateImage })
      .overrideProvider(OutboxDispatcherService)
      .useValue({})
      .overrideProvider(PublicationDispatcherService)
      .useValue({})
      .overrideProvider(SchedulerService)
      .useValue({})
      .compile();
    app = moduleReference.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
    usage = app.get(UsageService);
  });
  afterAll(async () => {
    if (app) await app.close();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    await app.get(PlanProvisioningService).provision();
    a = (await app.get(IdentityService).resolveBotUser({ telegramUserId: '910001' })).id;
    b = (await app.get(IdentityService).resolveBotUser({ telegramUserId: '910002' })).id;
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'pro' } });
    for (const userId of [a, b])
      await prisma.subscription.create({
        data: { userId, planId: plan.id, status: 'ACTIVE', startsAt: new Date(0) },
      });
    channelA = (
      await prisma.channel.create({
        data: { userId: a, telegramChatId: -100111n, title: 'A', status: 'ACTIVE' },
      })
    ).id;
    channelB = (
      await prisma.channel.create({
        data: { userId: b, telegramChatId: -100222n, title: 'B', status: 'ACTIVE' },
      })
    ).id;
    topicA = (
      await prisma.topic.create({ data: { userId: a, name: 'A', promptTemplate: 'Test guidance' } })
    ).id;
    topicB = (
      await prisma.topic.create({ data: { userId: b, name: 'B', promptTemplate: 'Test guidance' } })
    ).id;
    postA = (
      await prisma.post.create({
        data: {
          userId: a,
          channelId: channelA,
          topicId: topicA,
          prompt: 'original',
          publicationMode: 'AUTO',
          status: 'ACTIVE',
        },
      })
    ).id;
    postB = (
      await prisma.post.create({
        data: {
          userId: b,
          channelId: channelB,
          topicId: topicB,
          prompt: 'B original',
          publicationMode: 'MODERATION',
          status: 'ACTIVE',
        },
      })
    ).id;
    publicationA = (
      await prisma.publication.create({
        data: { postId: postA, status: 'READY', scheduledFor: new Date(0) },
      })
    ).id;
    publicationB = (
      await prisma.publication.create({
        data: { postId: postB, status: 'AWAITING_MODERATION', scheduledFor: new Date(0) },
      })
    ).id;
    const va = await prisma.postVersion.create({
      data: {
        postId: postA,
        publicationId: publicationA,
        sequence: 1,
        text: 'Test A final',
        status: 'APPROVED',
      },
    });
    const vb = await prisma.postVersion.create({
      data: {
        postId: postB,
        publicationId: publicationB,
        sequence: 1,
        text: 'Test B final',
        status: 'GENERATED',
      },
    });
    await prisma.publication.update({
      where: { id: publicationA },
      data: { selectedVersionId: va.id },
    });
    moderationB = (
      await prisma.moderationRequest.create({
        data: { postId: postB, publicationId: publicationB, versionId: vb.id },
      })
    ).id;
    scheduleB = (
      await prisma.postSchedule.create({
        data: {
          postId: postB,
          kind: 'ONCE',
          timezone: 'UTC',
          misfirePolicy: 'FIRE_ONCE',
          misfireGraceSeconds: 86400,
          runAt: new Date(Date.now() + 3600000),
          nextRunAt: new Date(Date.now() + 3600000),
        },
      })
    ).id;
    text.mockClear();
    sendText.mockClear();
    sendPhoto.mockClear();
    validateChannel.mockClear();
    text.mockResolvedValue({
      text: 'Test final artifact',
      providerRequestId: 'test-provider-id',
      inputUnits: 4,
      outputUnits: 4,
    });
    sendText.mockResolvedValue({ chatId: -100111n, messageId: 10n });
    sendPhoto.mockResolvedValue({ chatId: -100111n, messageId: 11n });
    generateImage.mockReset();
    generateImage.mockImplementation(async () => ({
      filePath: await app
        .get(ImageTempService)
        .createFile(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)),
    }));
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 5);
  });

  function call(method: string, path: string, payload?: unknown) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const builder = request(app.getHttpServer());
    const req =
      method === 'GET'
        ? builder.get(path)
        : method === 'PATCH'
          ? builder.patch(path)
          : method === 'DELETE'
            ? builder.delete(path)
            : builder.post(path);
    req
      .set(headers(method, path, body))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"');
    return body ? req.set('Content-Type', 'application/json').send(body) : req;
  }

  function responseBody(response: request.Response) {
    return response.body as {
      data: Record<string, unknown> & {
        id: string;
        telegram: Record<string, unknown> & { telegramUserId: string; username: string | null };
      };
      error: { code: string };
    };
  }
  // Second acceptance tranche: real HTTP, PostgreSQL and Redis; no external providers.
  const resolvePath = '/api/v1/internal/telegram-users/resolve';
  async function signedResolve(
    telegramUserId = '920001',
    payload: unknown = {},
    mutate?: (value: Record<string, string>) => void,
  ) {
    const body = JSON.stringify(payload);
    const signed = headers('POST', resolvePath, body, telegramUserId);
    mutate?.(signed);
    return request(app.getHttpServer())
      .post(resolvePath)
      .set(signed)
      .set('Content-Type', 'application/json')
      .send(body);
  }
  async function assertRejected(result: request.Response, code = 'INVALID_BOT_SIGNATURE') {
    expect(result.status).toBe(401);
    expect(responseBody(result).error.code).toBe(code);
    expect(await prisma.user.count()).toBe(2);
    expect(text).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  }
  it('TC-HMAC-001 valid raw request resolves signed identity', async () => {
    const result = await signedResolve();
    expect(result.status).toBe(200);
    expect(responseBody(result).data.telegram.telegramUserId).toBe('920001');
  });
  for (const missing of [
    'X-Autobot-Service',
    'X-Autobot-Key-Id',
    'X-Autobot-Timestamp',
    'X-Autobot-Nonce',
    'X-Autobot-Signature',
    'X-Telegram-User-Id',
  ]) {
    it(`TC-HMAC-002 missing ${missing}`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (value) => {
          delete value[missing];
        }),
      );
    });
  }
  for (const [id, key, value] of [
    ['003', 'X-Autobot-Service', 'other-service'],
    ['004', 'X-Autobot-Key-Id', 'unknown-key'],
    ['007', 'X-Telegram-User-Id', '910002'],
  ])
    it(`TC-HMAC-${id} altered ${key}`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (signed) => {
          signed[key!] = value!;
        }),
      );
    });
  for (const body of [
    '{ "firstName":"A","lastName":"B"}',
    '{"lastName":"B","firstName":"A"}',
    '{"firstName":"X","lastName":"B"}',
  ]) {
    it(`TC-HMAC-005 changed raw bytes ${body}`, async () => {
      const result = await request(app.getHttpServer())
        .post(resolvePath)
        .set(headers('POST', resolvePath, '{"firstName":"A","lastName":"B"}', '920001'))
        .set('Content-Type', 'application/json')
        .send(body);
      await assertRejected(result);
    });
  }
  for (const [method, path] of [
    ['GET', resolvePath],
    ['POST', '/api/v1/me'],
    ['POST', '/api/v1/channels/00000000-0000-4000-8000-000000000001'],
    ['POST', resolvePath + '?changed=1'],
  ]) {
    it(`TC-HMAC-006 signed method/path differs ${method} ${path}`, async () => {
      // Send to an existing protected route, signed for a different method/path/resource/query.
      await assertRejected(
        await request(app.getHttpServer())
          .post(resolvePath)
          .set(headers(method!, path!, '{}', '920001'))
          .set('Content-Type', 'application/json')
          .send('{}'),
      );
    });
  }
  it('TC-HMAC-008 sequential replay has no second business mutation', async () => {
    const signed = headers('POST', resolvePath, '{}', '920001');
    const send = () =>
      request(app.getHttpServer())
        .post(resolvePath)
        .set(signed)
        .set('Content-Type', 'application/json')
        .send('{}');
    expect((await send()).status).toBe(200);
    const result = await send();
    expect(result.status).toBe(401);
    expect(responseBody(result).error.code).toBe('BOT_REQUEST_REPLAYED');
    expect(await prisma.user.count()).toBe(3);
  });
  it('TC-HMAC-009 twenty concurrent nonce replays accept exactly one', async () => {
    const signed = headers('POST', resolvePath, '{}', '920001');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app.getHttpServer())
          .post(resolvePath)
          .set(signed)
          .set('Content-Type', 'application/json')
          .send('{}'),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 401 && responseBody(result).error.code === 'BOT_REQUEST_REPLAYED',
      ),
    ).toHaveLength(19);
    expect(await prisma.user.count()).toBe(3);
  });
  function resign(signed: Record<string, string>, key = secret) {
    signed['X-Autobot-Signature'] =
      'v1=' +
      createHmac('sha256', key)
        .update(
          canonicalBotRequest({
            method: 'POST',
            originalUrl: resolvePath,
            body: Buffer.from('{}'),
            timestamp: signed['X-Autobot-Timestamp']!,
            nonce: signed['X-Autobot-Nonce']!,
            telegramUserId: signed['X-Telegram-User-Id']!,
          }),
        )
        .digest('hex');
  }
  for (const [id, offset] of [
    ['010', -1000],
    ['011', 1000],
  ] as const) {
    it(`TC-HMAC-${id} correctly signed expired timestamp`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (signed) => {
          signed['X-Autobot-Timestamp'] = String(Math.floor(Date.now() / 1000) + offset);
          resign(signed);
        }),
        'BOT_REQUEST_EXPIRED',
      );
    });
  }
  for (const offset of [-61, -60, 60, 61]) {
    it(`TC-HMAC-012 clock skew boundary ${offset}`, async () => {
      const now = Math.floor(Date.now() / 1000) * 1000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const result = await signedResolve('920001', {}, (signed) => {
          signed['X-Autobot-Timestamp'] = String(now / 1000 + offset);
          resign(signed);
        });
        if (Math.abs(offset) <= 60) expect(result.status).toBe(200);
        else await assertRejected(result, 'BOT_REQUEST_EXPIRED');
      } finally {
        clock.mockRestore();
      }
    });
  }
  for (const value of ['1.5', 'NaN', 'Infinity', '99999999999999999999999999', '']) {
    it(`TC-HMAC-013 malformed timestamp ${value}`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (signed) => {
          signed['X-Autobot-Timestamp'] = value;
          resign(signed);
        }),
        /^\d+$/.test(value) ? 'BOT_REQUEST_EXPIRED' : 'INVALID_BOT_SIGNATURE',
      );
    });
  }
  for (const nonce of ['not-a-uuid', '00000000-0000-0000-8000-000000000001', 'a'.repeat(512)]) {
    it(`TC-HMAC-014 malformed nonce length ${nonce.length}`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (signed) => {
          signed['X-Autobot-Nonce'] = nonce;
          resign(signed);
        }),
      );
    });
  }
  for (const signature of [
    'v2=' + 'a'.repeat(64),
    'v1=' + 'a'.repeat(63),
    'v1=' + 'g'.repeat(64),
    'v1=' + 'A'.repeat(64),
    'V1=' + 'a'.repeat(64),
  ]) {
    it(`TC-HMAC-015 invalid signature ${signature.slice(0, 5)} length ${signature.length}`, async () => {
      await assertRejected(
        await signedResolve('920001', {}, (signed) => {
          signed['X-Autobot-Signature'] = signature;
        }),
      );
    });
  }
  it('TC-HMAC-016 previous key accepted then removed key rejected', async () => {
    const usePrevious = (signed: Record<string, string>) => {
      signed['X-Autobot-Key-Id'] = 'previous-key';
      resign(signed, 'previous-secret-32-bytes-long-123456');
    };
    expect((await signedResolve('920001', {}, usePrevious)).status).toBe(200);
    // Service snapshots config on construction, matching a restarted deployment after key removal.
    const config = new ConfigService<AppEnvironment, true>({
      BOT_SERVICE_ACTIVE_KEY_ID: 'test-key',
      BOT_SERVICE_ACTIVE_SECRET: secret,
      BOT_SERVICE_CLOCK_SKEW_SECONDS: 60,
      BOT_SERVICE_NONCE_TTL_SECONDS: 300,
    });
    vi.stubEnv('BOT_SERVICE_PREVIOUS_KEY_ID', undefined);
    vi.stubEnv('BOT_SERVICE_PREVIOUS_SECRET', undefined);
    try {
      const service = new BotRequestSignatureService(config, app.get(RedisService));
      const signed = headers('POST', resolvePath, '{}');
      usePrevious(signed);
      await expect(
        service.authenticate({
          method: 'POST',
          originalUrl: resolvePath,
          rawBody: Buffer.from('{}'),
          get: (name: string) =>
            Object.entries(signed).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1],
        } as unknown as Request),
      ).rejects.toMatchObject({ response: { code: 'INVALID_BOT_SIGNATURE' } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  for (const method of ['GET', 'POST'])
    it(`TC-HMAC-019 empty raw body ${method}`, async () => {
      const path = method === 'GET' ? '/api/v1/me' : resolvePath;
      const builder = request(app.getHttpServer());
      const result = await (method === 'GET' ? builder.get(path) : builder.post(path)).set(
        headers(method, path, ''),
      );
      expect(result.status).toBe(200);
      expect(responseBody(result).data.id).toBe(a);
    });
  it('TC-HMAC-020 internal onboarding rejects unsigned calls', async () => {
    await assertRejected(await request(app.getHttpServer()).post(resolvePath).send({}));
  });
  it('TC-USR-001 first onboarding creates canonical identity records', async () => {
    const result = await signedResolve();
    expect(result.status).toBe(200);
    const userId = responseBody(result).data.id;
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    expect(await prisma.telegramAccount.count({ where: { userId, telegramUserId: 920001n } })).toBe(
      1,
    );
    const identityCount = await prisma.authIdentity.count({
      where: { userId, provider: 'TELEGRAM' },
    });
    console.info(
      'ACCEPTANCE_EVIDENCE',
      JSON.stringify({
        caseId: 'TC-USR-001',
        users: await prisma.user.count({ where: { id: userId } }),
        accounts: await prisma.telegramAccount.count({ where: { userId } }),
        identities: identityCount,
      }),
    );
    expect(identityCount).toBe(1);
  });
  it('TC-USR-002 repeated onboarding preserves user and account', async () => {
    const first = await signedResolve();
    const second = await signedResolve();
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(responseBody(first).data.id).toBe(responseBody(second).data.id);
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.telegramAccount.count({ where: { telegramUserId: 920001n } })).toBe(1);
  });
  it('TC-USR-003 twenty concurrent onboarding calls create one user', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => signedResolve()));
    console.info(
      'ACCEPTANCE_EVIDENCE',
      JSON.stringify({
        caseId: 'TC-USR-003',
        statuses: results.map((result) => result.status),
        users: await prisma.user.count(),
        accounts: await prisma.telegramAccount.count({ where: { telegramUserId: 920001n } }),
      }),
    );
    expect(results.map((result) => result.status)).toEqual(Array(20).fill(200));
    expect(new Set(results.map((result) => responseBody(result).data.id)).size).toBe(1);
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.telegramAccount.count({ where: { telegramUserId: 920001n } })).toBe(1);
  });
  it('TC-USR-004 allowed profile metadata changes keep canonical user', async () => {
    const first = await signedResolve('920001', {
      username: 'old',
      firstName: 'Old',
      lastName: 'Old',
      languageCode: 'ru',
    });
    const next = await signedResolve('920001', {
      username: 'new',
      firstName: 'New',
      lastName: 'New',
      languageCode: 'en',
    });
    expect(next.status).toBe(200);
    expect(responseBody(next).data.id).toBe(responseBody(first).data.id);
    expect(responseBody(next).data.telegram).toMatchObject({
      username: 'new',
      firstName: 'New',
      lastName: 'New',
    });
    expect(await prisma.telegramAccount.count({ where: { telegramUserId: 920001n } })).toBe(1);
  });
  it('TC-USR-005 omitted username retained, explicit null clears it', async () => {
    const first = await signedResolve('920001', { username: 'old' });
    const omitted = await signedResolve();
    expect(responseBody(omitted).data.telegram.username).toBe('old');
    const cleared = await signedResolve('920001', { username: null });
    expect(responseBody(cleared).data.telegram.username).toBeNull();
    expect(responseBody(cleared).data.id).toBe(responseBody(first).data.id);
    expect(await prisma.telegramAccount.count({ where: { telegramUserId: 920001n } })).toBe(1);
  });
  for (const status of ['BLOCKED', 'DELETED'] as const) {
    it(`TC-USR-${status === 'BLOCKED' ? '007' : '008'} inactive user denied across routes`, async () => {
      await prisma.user.update({ where: { id: a }, data: { status } });
      const me = await call('GET', '/api/v1/me');
      expect(me.status).toBe(401);
      const command = await call('POST', '/api/v1/topics', {
        name: 'Forbidden',
        promptTemplate: 'x',
      });
      expect(command.status).toBe(401);
      const resolve = await signedResolve('910001');
      const storedStatus = (await prisma.user.findUniqueOrThrow({ where: { id: a } })).status;
      expect(storedStatus).toBe(status);
      expect(await prisma.user.count()).toBe(2);
      console.info(
        'ACCEPTANCE_EVIDENCE',
        JSON.stringify({
          caseId: status === 'BLOCKED' ? 'TC-USR-007' : 'TC-USR-008',
          meStatus: me.status,
          commandStatus: command.status,
          resolveStatus: resolve.status,
          storedStatus,
        }),
      );
      if (status === 'BLOCKED') {
        expect(resolve.status).toBe(200);
        expect(responseBody(resolve).data.status).toBe('BLOCKED');
      } else expect([401, 403]).toContain(resolve.status);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a } })).status).toBe(status);
      expect(await prisma.user.count()).toBe(2);
    });
  }
  it('TC-USR-009 large Telegram ID retains exact digits in database and JSON', async () => {
    const id = '9007199254740993';
    const result = await signedResolve(id);
    expect(result.status).toBe(200);
    expect(responseBody(result).data.telegram.telegramUserId).toBe(id);
    expect(
      (
        await prisma.telegramAccount.findUniqueOrThrow({ where: { telegramUserId: BigInt(id) } })
      ).telegramUserId.toString(),
    ).toBe(id);
  });
  for (const id of ['0', '-1', '1.5', '1e6', 'text']) {
    it(`TC-USR-010 invalid Telegram ID ${id}`, async () => {
      await assertRejected(await signedResolve(id));
    });
  }
  it('TC-USR-011 current profile exposes only documented safe fields', async () => {
    const result = await call('GET', '/api/v1/me');
    expect(result.status).toBe(200);
    expect(Object.keys(responseBody(result).data).sort()).toEqual(
      ['id', 'status', 'locale', 'timezone', 'telegram', 'createdAt'].sort(),
    );
    expect(responseBody(result).data.id).toBe(a);
    expect(Object.keys(responseBody(result).data.telegram).sort()).toEqual(
      ['telegramUserId', 'username', 'firstName', 'lastName', 'photoUrl'].sort(),
    );
  });
  for (const payload of [{ userId: 'other' }, { telegramUserId: '910002' }, { id: 'other' }]) {
    it(`TC-USR-012 cannot choose identity through ${Object.keys(payload)[0]}`, async () => {
      const before = await prisma.telegramAccount.findUniqueOrThrow({
        where: { telegramUserId: 910002n },
      });
      const result = await signedResolve('910001', payload);
      expect(result.status).toBe(400);
      expect(
        await prisma.telegramAccount.findUniqueOrThrow({ where: { telegramUserId: 910002n } }),
      ).toEqual(before);
      expect(await prisma.user.count()).toBe(2);
    });
  }

  it('TC-TOP-001 create stores owned active topic', async () => {
    const result = await call('POST', '/api/v1/topics', { name: 'New', promptTemplate: 'Guide' });
    expect(result.status).toBe(201);
    const stored = await prisma.topic.findUniqueOrThrow({
      where: { id: responseBody(result).data.id },
    });
    expect(stored).toMatchObject({
      userId: a,
      status: 'ACTIVE',
      name: 'New',
      promptTemplate: 'Guide',
    });
  });
  for (const description of [undefined, null, ''])
    it(`TC-TOP-002 optional description ${String(description)}`, async () => {
      const result = await call('POST', '/api/v1/topics', {
        name: 'New',
        promptTemplate: 'Guide',
        ...(description !== undefined ? { description } : {}),
      });
      expect(result.status).toBe(201);
      expect(responseBody(result).data.description).toBeNull();
      expect(
        (await prisma.topic.findUniqueOrThrow({ where: { id: responseBody(result).data.id } }))
          .description,
      ).toBeNull();
    });
  for (const field of ['name', 'description', 'promptTemplate'] as const)
    it(`TC-TOP-003 partial update ${field}`, async () => {
      const before = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
      const result = await call('PATCH', `/api/v1/topics/${topicA}`, { [field]: 'Changed' });
      expect(result.status).toBe(200);
      const after = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
      for (const key of ['name', 'description', 'promptTemplate'] as const)
        expect(after[key]).toBe(key === field ? 'Changed' : before[key]);
      expect(after.version).toBe(before.version + 1);
      expect(after.userId).toBe(a);
    });
  it('TC-TOP-004 explicit null clears description only', async () => {
    await prisma.topic.update({ where: { id: topicA }, data: { description: 'Old' } });
    expect((await call('PATCH', `/api/v1/topics/${topicA}`, { description: null })).status).toBe(
      200,
    );
    expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toMatchObject({
      description: null,
      name: 'A',
      promptTemplate: 'Test guidance',
      version: 2,
    });
  });
  it('TC-TOP-005 topic owner cannot be changed', async () => {
    const before = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
    expect((await call('PATCH', `/api/v1/topics/${topicA}`, { userId: b })).status).toBe(400);
    expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toEqual(before);
  });
  it('TC-TOP-006 archive persists topic and frees active capacity', async () => {
    const before = await prisma.topic.count({ where: { userId: a, status: 'ACTIVE' } });
    expect((await call('DELETE', `/api/v1/topics/${topicA}`)).status).toBe(204);
    expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toMatchObject({
      status: 'ARCHIVED',
      version: 2,
    });
    expect(await prisma.topic.count({ where: { userId: a, status: 'ACTIVE' } })).toBe(before - 1);
  });
  it('TC-TOP-007 archived topic rejected for new post', async () => {
    expect((await call('DELETE', `/api/v1/topics/${topicA}`)).status).toBe(204);
    const result = await call('POST', '/api/v1/posts', {
      channelId: channelA,
      topicId: topicA,
      prompt: 'New',
      publicationMode: 'AUTO',
    });
    expect([403, 409, 422]).toContain(result.status);
    expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
    expect(text).not.toHaveBeenCalled();
  });
  it('TC-TOP-008 same owned topic shared by posts on two channels', async () => {
    const secondChannel = await prisma.channel.create({
      data: { userId: a, telegramChatId: -100333n, title: 'second', status: 'ACTIVE' },
    });
    for (const channelId of [channelA, secondChannel.id]) {
      expect(
        (
          await call('POST', '/api/v1/posts', {
            channelId,
            topicId: topicA,
            prompt: 'New',
            publicationMode: 'AUTO',
          })
        ).status,
      ).toBe(201);
    }
    expect(await prisma.post.count({ where: { userId: a, topicId: topicA } })).toBe(3);
    expect(await prisma.topic.count({ where: { id: topicA } })).toBe(1);
  });
  for (const method of ['POST', 'PATCH'])
    it(`TC-TOP-009 foreign topic rejected ${method}`, async () => {
      const before = await prisma.post.findUniqueOrThrow({ where: { id: postA } });
      const result = await call(
        method,
        method === 'POST' ? '/api/v1/posts' : `/api/v1/posts/${postA}`,
        { channelId: channelA, topicId: topicB, prompt: 'New', publicationMode: 'AUTO' },
      );
      expect(result.status).toBe(422);
      expect(responseBody(result).error.code).toBe('TOPIC_NOT_ACTIVE');
      expect(await prisma.post.findUniqueOrThrow({ where: { id: postA } })).toEqual(before);
      expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
    });
  it('TC-TOP-010 template update preserves existing immutable versions', async () => {
    const before = await prisma.postVersion.findMany({ where: { postId: postA } });
    expect(before.length).toBeGreaterThan(0);
    expect(
      (await call('PATCH', `/api/v1/topics/${topicA}`, { promptTemplate: 'Changed' })).status,
    ).toBe(200);
    expect(await prisma.postVersion.findMany({ where: { postId: postA } })).toEqual(before);
  });
  it('TC-TOP-012 pagination excludes archived and foreign topics', async () => {
    for (let index = 0; index < 3; index++)
      await prisma.topic.create({
        data: { userId: a, name: `page${index}`, promptTemplate: 'Guide' },
      });
    await prisma.topic.create({
      data: { userId: a, name: 'Archived', promptTemplate: 'Guide', status: 'ARCHIVED' },
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await call(
        'GET',
        '/api/v1/topics?limit=1' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        data: { id: string; status: string }[];
        page: { nextCursor: string | null; hasMore: boolean };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.status).toBe('ACTIVE');
      seen.push(body.data[0]!.id);
      cursor = body.page.nextCursor;
      expect(body.page.hasMore).toBe(cursor !== null);
      expect(seen.length).toBeLessThanOrEqual(4);
    } while (cursor);
    const expected = await prisma.topic.findMany({ where: { userId: a, status: 'ACTIVE' } });
    expect(seen.sort()).toEqual(expected.map((row) => row.id).sort());
    expect(new Set(seen).size).toBe(4);
  });
  for (const id of ['@test', 'https://t.me/test'])
    it(`TC-CHN-003 username or URL rejected ${id}`, async () => {
      expect((await call('POST', '/api/v1/channels', { telegramChatId: id })).status).toBe(400);
      expect(validateChannel).not.toHaveBeenCalled();
      expect(await prisma.channel.count()).toBe(2);
    });
  it('TC-CHN-008 negative large chat ID preserves digits', async () => {
    const id = '-9007199254740993';
    const result = await call('POST', '/api/v1/channels', { telegramChatId: id });
    expect(result.status).toBe(201);
    expect(responseBody(result).data.telegramChatId).toBe(id);
    expect(
      (await prisma.channel.findUniqueOrThrow({ where: { telegramChatId: BigInt(id) } })).userId,
    ).toBe(a);
    const read = await call('GET', `/api/v1/channels/${responseBody(result).data.id}`);
    expect(read.status).toBe(200);
    expect(responseBody(read).data.telegramChatId).toBe(id);
  });
  it('TC-CHN-009 repeated link with same and fresh command key has no duplicate', async () => {
    const path = '/api/v1/channels';
    const body = JSON.stringify({ telegramChatId: '-100333' });
    const key = randomUUID();
    const create = () =>
      request(app.getHttpServer())
        .post(path)
        .set(headers('POST', path, body))
        .set('Idempotency-Key', key)
        .set('Content-Type', 'application/json')
        .send(body);
    const first = await create();
    const replay = await create();
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(responseBody(first).data.id).toBe(responseBody(replay).data.id);
    expect((await call('POST', path, { telegramChatId: '-100333' })).status).toBe(409);
    expect(await prisma.channel.count({ where: { userId: a, status: 'ACTIVE' } })).toBe(2);
  });
  it('TC-CHN-010 channel cannot be claimed by another owner', async () => {
    expect((await call('POST', '/api/v1/channels', { telegramChatId: '-100222' })).status).toBe(
      409,
    );
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelB } })).userId).toBe(b);
    expect(await prisma.channel.count()).toBe(2);
  });
  it('TC-CHN-014 title update preserves all other channel metadata', async () => {
    const before = await prisma.channel.findUniqueOrThrow({ where: { id: channelA } });
    expect((await call('PATCH', `/api/v1/channels/${channelA}`, { title: 'Changed' })).status).toBe(
      200,
    );
    const after = await prisma.channel.findUniqueOrThrow({ where: { id: channelA } });
    expect(after).toEqual({ ...before, title: 'Changed', version: 2, updatedAt: after.updatedAt });
  });
  it('TC-CHN-015 concurrent edits allow exactly one version winner', async () => {
    const results = await Promise.all(
      ['First', 'Second'].map((title) => call('PATCH', `/api/v1/channels/${channelA}`, { title })),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).toMatchObject({
      version: 2,
      title: responseBody(winner).data.title,
    });
  });
  for (const id of ['016', '022'])
    it(`TC-CHN-${id} archive preserves dependent records and history`, async () => {
      const beforePosts = await prisma.post.findMany({ where: { channelId: channelA } });
      const beforePublications = await prisma.publication.findMany({ where: { postId: postA } });
      const beforeVersions = await prisma.postVersion.findMany({ where: { postId: postA } });
      expect((await call('DELETE', `/api/v1/channels/${channelA}`)).status).toBe(204);
      expect(await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).toMatchObject({
        status: 'ARCHIVED',
        version: 2,
      });
      expect(await prisma.post.findMany({ where: { channelId: channelA } })).toEqual(beforePosts);
      expect(await prisma.publication.findMany({ where: { postId: postA } })).toEqual(
        beforePublications,
      );
      expect(await prisma.postVersion.findMany({ where: { postId: postA } })).toEqual(
        beforeVersions,
      );
    });

  function mutation(
    method: string,
    path: string,
    payload: unknown,
    key: string | null = randomUUID(),
    version: string | null = '"1"',
    user = '910001',
  ) {
    const raw = JSON.stringify(payload);
    const builder = request(app.getHttpServer());
    const req =
      method === 'PATCH'
        ? builder.patch(path)
        : method === 'DELETE'
          ? builder.delete(path)
          : builder.post(path);
    req.set(headers(method, path, raw, user)).set('Content-Type', 'application/json');
    if (key !== null) req.set('Idempotency-Key', key);
    if (version !== null) req.set('If-Match', version);
    return req.send(raw);
  }
  for (const path of ['/api/v1/does-not-exist', '/api/v999/me'])
    it(`TC-HTTP-002 unknown route ${path}`, async () => {
      const result = await request(app.getHttpServer()).get(path);
      expect(result.status).toBe(404);
      expect(responseBody(result).error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(result.body)).not.toMatch(/stack|node_modules|SELECT /i);
    });
  it('TC-HTTP-003 unsupported method has no side effects', async () => {
    const path = '/api/v1/me';
    const result = await request(app.getHttpServer())
      .put(path)
      .set(headers('PUT', path, ''));
    expect(result.status).toBe(404);
    expect(await prisma.user.count()).toBe(2);
  });
  for (const raw of ['{"name":', "{'name':'invalid'}"])
    it(`TC-HTTP-004 malformed JSON ${raw}`, async () => {
      const path = '/api/v1/topics';
      const result = await request(app.getHttpServer())
        .post(path)
        .set(headers('POST', path, raw))
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', randomUUID())
        .send(raw);
      expect(result.status).toBe(400);
      expect(await prisma.topic.count()).toBe(2);
    });
  for (const field of ['userId', 'status', 'telegramMessageId', 'createdAt'])
    it(`TC-HTTP-005 mass assignment ${field}`, async () => {
      expect(
        (
          await call('POST', '/api/v1/topics', {
            name: 'New',
            promptTemplate: 'Guide',
            [field]: 'injected',
          })
        ).status,
      ).toBe(400);
      expect(await prisma.topic.count()).toBe(2);
    });
  for (const payload of [
    { name: 123, promptTemplate: 'Guide' },
    [{ name: 'New', promptTemplate: 'Guide' }],
    {
      channelId: 'valid-placeholder',
      prompt: 'Test',
      publicationMode: 'AUTO',
      generateImage: 'true',
    },
  ]) {
    it(`TC-HTTP-006 incompatible DTO type ${JSON.stringify(payload)}`, async () => {
      const path =
        !Array.isArray(payload) && 'generateImage' in payload ? '/api/v1/posts' : '/api/v1/topics';
      const input = path.endsWith('posts') ? { ...payload, channelId: channelA } : payload;
      expect((await call('POST', path, input)).status).toBe(400);
      expect(await prisma.topic.count()).toBe(2);
      expect(await prisma.post.count()).toBe(2);
    });
  }
  it('TC-IDM-001 missing command key rejected before persistence', async () => {
    const result = await mutation(
      'POST',
      '/api/v1/topics',
      { name: 'New', promptTemplate: 'Guide' },
      null,
    );
    expect(result.status).toBe(400);
    expect(responseBody(result).error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(await prisma.topic.count()).toBe(2);
  });
  for (const length of [15, 16, 128, 129])
    it(`TC-IDM-002 command key length ${length}`, async () => {
      const result = await mutation(
        'POST',
        '/api/v1/topics',
        { name: 'New', promptTemplate: 'Guide' },
        'a'.repeat(length),
      );
      expect(result.status).toBe(length === 16 || length === 128 ? 201 : 400);
      expect(await prisma.topic.count()).toBe(length === 16 || length === 128 ? 3 : 2);
    });
  for (const [id, changed, reordered] of [
    ['004', false, false],
    ['005', true, false],
    ['006', false, true],
  ] as const) {
    it(`TC-IDM-${id} replay identity`, async () => {
      const key = randomUUID();
      const payload = { name: 'New', promptTemplate: 'Guide' };
      const first = await mutation('POST', '/api/v1/topics', payload, key);
      expect(first.status).toBe(201);
      const repeat = await mutation(
        'POST',
        '/api/v1/topics',
        changed
          ? { ...payload, name: 'Changed' }
          : reordered
            ? { promptTemplate: 'Guide', name: 'New' }
            : payload,
        key,
      );
      expect(repeat.status).toBe(changed ? 409 : 201);
      if (changed) expect(responseBody(repeat).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      else expect(responseBody(repeat).data).toEqual(responseBody(first).data);
      expect(await prisma.topic.count()).toBe(3);
    });
  }
  it('TC-IDM-008 command keys are isolated per user', async () => {
    const key = randomUUID();
    const payload = { name: 'New', promptTemplate: 'Guide' };
    const first = await mutation('POST', '/api/v1/topics', payload, key);
    const second = await mutation('POST', '/api/v1/topics', payload, key, '"1"', '910002');
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(responseBody(first).data.id).not.toBe(responseBody(second).data.id);
    expect(
      (await prisma.topic.findUniqueOrThrow({ where: { id: responseBody(first).data.id } })).userId,
    ).toBe(a);
    expect(
      (await prisma.topic.findUniqueOrThrow({ where: { id: responseBody(second).data.id } }))
        .userId,
    ).toBe(b);
  });
  it('TC-IDM-009 command key scopes distinguish topic and post creation', async () => {
    const key = randomUUID();
    expect(
      (await mutation('POST', '/api/v1/topics', { name: 'New', promptTemplate: 'Guide' }, key))
        .status,
    ).toBe(201);
    expect(
      (
        await mutation(
          'POST',
          '/api/v1/posts',
          { channelId: channelA, prompt: 'New', publicationMode: 'AUTO' },
          key,
        )
      ).status,
    ).toBe(201);
    expect(await prisma.topic.count()).toBe(3);
    expect(await prisma.post.count()).toBe(3);
  });
  it('TC-IDM-011 failed transaction does not leave a successful replay', async () => {
    const key = randomUUID();
    const body = { name: 'A', promptTemplate: 'Guide' };
    expect((await mutation('POST', '/api/v1/topics', body, key)).status).toBe(409);
    await prisma.topic.update({ where: { id: topicA }, data: { name: 'Renamed' } });
    const next = await mutation('POST', '/api/v1/topics', body, key);
    expect(next.status).toBe(201);
    expect(await prisma.topic.count()).toBe(3);
  });
  for (const method of ['PATCH', 'DELETE'])
    it(`TC-IDM-013 missing If-Match ${method}`, async () => {
      const before = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
      const result = await mutation(
        method,
        `/api/v1/topics/${topicA}`,
        method === 'PATCH' ? { name: 'Changed' } : {},
        randomUUID(),
        null,
      );
      expect(result.status).toBe(400);
      expect(responseBody(result).error.code).toBe('IF_MATCH_REQUIRED');
      expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toEqual(before);
    });
  for (const decision of ['approve', 'reject', 'revision']) {
    it(`TC-IDM-013 missing If-Match moderation ${decision}`, async () => {
      const before = await prisma.moderationRequest.findUniqueOrThrow({
        where: { id: moderationB },
      });
      const publication = await prisma.publication.findUniqueOrThrow({
        where: { id: publicationB },
      });
      const result = await mutation(
        'POST',
        `/api/v1/moderation/${moderationB}/${decision}`,
        decision === 'revision' ? { feedback: 'Revise' } : {},
        randomUUID(),
        null,
        '910002',
      );
      expect(result.status).toBe(400);
      expect(responseBody(result).error.code).toBe('IF_MATCH_REQUIRED');
      expect(
        await prisma.moderationRequest.findUniqueOrThrow({ where: { id: moderationB } }),
      ).toEqual(before);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id: publicationB } })).toEqual(
        publication,
      );
      expect(text).not.toHaveBeenCalled();
    });
  }
  for (const version of ['1', '"0"', '"-1"', 'W/"1"', '*', '"9007199254740992"'])
    it(`TC-IDM-014 malformed version ${version}`, async () => {
      const before = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
      const result = await mutation(
        'PATCH',
        `/api/v1/topics/${topicA}`,
        { name: 'Changed' },
        randomUUID(),
        version,
      );
      expect(result.status).toBe(400);
      expect(responseBody(result).error.code).toBe('INVALID_IF_MATCH');
      expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toEqual(before);
    });
  it('TC-IDM-015 stale version does not overwrite newer state', async () => {
    expect((await call('PATCH', `/api/v1/topics/${topicA}`, { name: 'First' })).status).toBe(200);
    const before = await prisma.topic.findUniqueOrThrow({ where: { id: topicA } });
    const result = await call('PATCH', `/api/v1/topics/${topicA}`, { name: 'Lost update' });
    expect(result.status).toBe(409);
    expect(responseBody(result).error.code).toBe('STALE_RESOURCE_VERSION');
    expect(await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).toEqual(before);
  });

  it('TC-USR-006 conflicting identity links cannot merge users', async () => {
    const identities = app.get(IdentityService);
    await identities.resolveOidcUser({ subject: 'acceptance-conflict', telegramUserId: '910001' });
    const beforeUsers = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    const beforeAccounts = await prisma.telegramAccount.findMany({ orderBy: { id: 'asc' } });
    const beforeIdentities = await prisma.authIdentity.findMany({ orderBy: { id: 'asc' } });
    await expect(
      identities.resolveOidcUser({ subject: 'acceptance-conflict', telegramUserId: '910002' }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_LINK_CONFLICT' } });
    expect(await prisma.user.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeUsers);
    expect(await prisma.telegramAccount.findMany({ orderBy: { id: 'asc' } })).toEqual(
      beforeAccounts,
    );
    expect(await prisma.authIdentity.findMany({ orderBy: { id: 'asc' } })).toEqual(
      beforeIdentities,
    );
  });
  it('TC-HTTP-010 unexpected provider error hides diagnostic content', async () => {
    validateChannel.mockRejectedValueOnce(
      new Error('SELECT diagnostic_marker https://internal.invalid/?token=fixture_secret'),
    );
    const result = await call('POST', '/api/v1/channels', { telegramChatId: '-100333' });
    expect(result.status).toBe(500);
    expect(responseBody(result).error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(result.body)).not.toMatch(
      /SELECT|diagnostic_marker|internal\.invalid|fixture_secret|stack|node_modules/,
    );
    expect(await prisma.channel.count()).toBe(2);
  });
  it('TC-HTTP-011 different error classes share documented envelope and request ID', async () => {
    const validation = await call('POST', '/api/v1/topics', { name: 1 });
    const missing = await call('GET', '/api/v1/topics/' + randomUUID());
    const conflict = await call('POST', '/api/v1/topics', { name: 'A', promptTemplate: 'Guide' });
    validateChannel.mockRejectedValueOnce(new Error('fixture failure'));
    const unexpected = await call('POST', '/api/v1/channels', { telegramChatId: '-100333' });
    const unsigned = await request(app.getHttpServer()).get('/api/v1/me');
    expect([
      validation.status,
      missing.status,
      conflict.status,
      unexpected.status,
      unsigned.status,
    ]).toEqual([400, 404, 409, 500, 401]);
    for (const result of [validation, missing, conflict, unexpected, unsigned]) {
      const body = result.body as {
        error: { code: unknown; message: unknown; details: unknown; requestId: unknown };
      };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(
        ['code', 'message', 'details', 'requestId'].sort(),
      );
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(typeof body.error.details).toBe('object');
      expect(body.error.requestId).toBe(result.headers['x-request-id']);
    }
    expect(await prisma.topic.count()).toBe(2);
    expect(await prisma.channel.count()).toBe(2);
  });

  for (const row of catalogRows.filter(([id]) => id?.startsWith('TC-OWN-'))) {
    it(`${row[0]} ${row[2]}`, async () => {
      const operation = row[2]!.split(': чужой')[0]!;
      const [method, template] = operation.split(' ');
      const resource = template!.split('/')[1]!;
      const id = {
        channels: channelB,
        topics: topicB,
        posts: postB,
        schedules: scheduleB,
        publications: publicationB,
        moderation: moderationB,
      }[resource];
      expect(id).toBeDefined();
      const payload =
        method === 'PATCH'
          ? resource === 'channels'
            ? { title: 'x' }
            : resource === 'topics'
              ? { name: 'x' }
              : resource === 'posts'
                ? { prompt: 'x' }
                : { timezone: 'UTC' }
          : template!.endsWith('/revision')
            ? { feedback: 'shorter' }
            : undefined;
      const before = await prisma.publication.findUniqueOrThrow({ where: { id: publicationB } });
      const result = await call(method!, '/api/v1' + template!.replace(':id', id!), payload);
      expect([403, 404]).toContain(result.status);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id: publicationB } })).toEqual(
        before,
      );
      expect((await prisma.post.findUniqueOrThrow({ where: { id: postB } })).prompt).toBe(
        'B original',
      );
      expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelB } })).title).toBe('B');
      expect((await prisma.topic.findUniqueOrThrow({ where: { id: topicB } })).name).toBe('B');
      expect(
        (await prisma.postSchedule.findUniqueOrThrow({ where: { id: scheduleB } })).status,
      ).toBe('ACTIVE');
      expect(
        (await prisma.moderationRequest.findUniqueOrThrow({ where: { id: moderationB } })).status,
      ).toBe('PENDING');
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
      expect(text).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(sendPhoto).not.toHaveBeenCalled();
      expect(validateChannel).not.toHaveBeenCalled();
    });
  }

  for (const row of catalogRows.filter(([id]) => id?.startsWith('TC-STM-'))) {
    it(`${row[0]} ${row[2]}`, async () => {
      const [command, , rawState] = row[2]!.split(' ');
      const status = rawState as PublicationStatus;
      await prisma.publication.update({
        where: { id: publicationA },
        data: {
          status,
          errorCode: status === 'FAILED' ? 'TELEGRAM_RATE_LIMIT' : null,
          nextAttemptAt: new Date(0),
        },
      });
      if (status === 'PENDING')
        await usage.reserve({
          userId: a,
          metric: 'TEXT_GENERATION',
          amount: 1,
          operationKey: `publication:${publicationA}:text-generation:reserve`,
          metadata: { publicationId: publicationA },
        });
      const before = await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } });
      if (command === 'cancel' || command === 'retry') {
        const response = await call('POST', `/api/v1/publications/${publicationA}/${command}`);
        const allowed =
          command === 'retry'
            ? status === 'FAILED'
            : ['PENDING', 'AWAITING_MODERATION', 'READY', 'RETRY_WAIT', 'CANCELLED'].includes(
                status,
              );
        if (allowed) {
          expect(response.status).toBeLessThan(300);
          expect(
            (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
          ).toBe(command === 'cancel' ? 'CANCELLED' : 'READY');
          if (status === 'PENDING')
            expect(
              (await usage.summary(a)).items.find((item) => item.metric === 'TEXT_GENERATION')
                ?.reserved,
            ).toBe(0);
        } else {
          expect(response.status).toBe(409);
          expect(
            await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } }),
          ).toEqual(before);
        }
      } else if (command === 'generate') {
        await app.get(GenerationService).generate(publicationA, false);
        expect(text).toHaveBeenCalledTimes(status === 'PENDING' ? 1 : 0);
        if (status === 'PENDING') {
          expect(
            (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
          ).toBe('READY');
          expect(await prisma.aIRequest.count()).toBe(1);
          expect(
            (await usage.summary(a)).items.find((item) => item.metric === 'TEXT_GENERATION'),
          ).toMatchObject({ reserved: 0, committed: 1 });
        } else
          expect(
            await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } }),
          ).toEqual(before);
      } else {
        await app.get(PublishingService).publish(publicationA);
        const allowed = ['READY', 'RETRY_WAIT'].includes(status);
        expect(sendText).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(sendPhoto).not.toHaveBeenCalled();
        if (allowed)
          expect(
            (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
          ).toBe('PUBLISHED');
        else
          expect(
            await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } }),
          ).toEqual(before);
      }
    });
  }

  for (const row of catalogRows.filter(
    ([id, , name]) =>
      id?.startsWith('TC-BND-') &&
      !name?.includes('telegramChatId') &&
      !name?.includes('/moderation'),
  )) {
    const match =
      /^(POST\/PATCH|PATCH) \/(channels|topics|posts)(?:\/:id)?: (\w+), длина (\d+)$/.exec(row[2]!);
    if (!match) throw new Error(`Unrecognized boundary case ${row[0]}`);
    const [, methods, resource, field, length] = match;
    for (const method of methods!.split('/'))
      it(`${row[0]} ${row[2]} [${method}]`, async () => {
        const id = resource === 'channels' ? channelA : resource === 'topics' ? topicA : postA;
        const payload: Record<string, unknown> =
          method === 'POST'
            ? resource === 'topics'
              ? { name: 'valid', promptTemplate: 'valid' }
              : { channelId: channelA, prompt: 'valid', publicationMode: 'AUTO' }
            : {};
        payload[field!] = 'a'.repeat(Number(length));
        const response = await call(
          method,
          `/api/v1/${resource}` + (method === 'PATCH' ? `/${id}` : ''),
          payload,
        );
        if (row[5]?.startsWith('400')) expect(response.status).toBe(400);
        else {
          expect(response.status).toBeLessThan(300);
          const data = (response.body as { data: Record<string, unknown> }).data;
          // Optional empty metadata is normalized to null by the domain services.
          const expected =
            Number(length) === 0 && ['title', 'description'].includes(field!)
              ? null
              : payload[field!];
          expect(data[field!]).toBe(expected);
        }
        expect(sendText).not.toHaveBeenCalled();
        expect(sendPhoto).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
      });
  }

  async function enableImage() {
    await prisma.post.update({ where: { id: postA }, data: { generateImage: true } });
    await usage.reserve({
      userId: a,
      metric: 'IMAGE_GENERATION',
      amount: 1,
      operationKey: `publication:${publicationA}:image-generation:reserve`,
      metadata: { publicationId: publicationA },
    });
  }

  async function observe(caseId: string, extra: Record<string, unknown> = {}) {
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } });
    const imageUsage = (await usage.summary(a)).items.find(
      (item) => item.metric === 'IMAGE_GENERATION',
    );
    console.info(
      'ACCEPTANCE_EVIDENCE ' +
        JSON.stringify({
          caseId,
          publicationStatus: publication.status,
          errorCode: publication.errorCode,
          attemptCount: publication.attemptCount,
          imageUsage,
          photoCalls: sendPhoto.mock.calls.length,
          ...extra,
        }),
    );
  }

  it('TC-USG-015 manual retry after terminal release restores the image reservation', async () => {
    await enableImage();
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 1);
    generateImage.mockRejectedValueOnce(
      new ImageGenerationProviderError('AI_IMAGE_PROVIDER_NETWORK_ERROR', true),
    );
    await app.get(PublishingService).publish(publicationA);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('FAILED');
    expect(
      (await usage.summary(a)).items.find((item) => item.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 0 });
    await call('POST', `/api/v1/publications/${publicationA}/retry`).expect(202);
    await app.get(PublishingService).publish(publicationA);
    await observe('TC-USG-015');
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('PUBLISHED');
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(
      (await usage.summary(a)).items.find((item) => item.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 1 });
  });

  it('TC-USG-014 an image failure after earlier image commit does not attempt a second release', async () => {
    await enableImage();
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 2);
    sendPhoto.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 1),
    );
    await app.get(PublishingService).publish(publicationA);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('RETRY_WAIT');
    await prisma.publication.update({
      where: { id: publicationA },
      data: { nextAttemptAt: new Date(0) },
    });
    generateImage.mockRejectedValueOnce(
      new ImageGenerationProviderError('AI_PROVIDER_FORBIDDEN', false),
    );
    const outcome = app.get(PublishingService).publish(publicationA);
    await outcome.catch(() => undefined);
    await observe('TC-USG-014');
    await expect(outcome).resolves.toBeUndefined();
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('FAILED');
    expect(
      (await usage.summary(a)).items.find((item) => item.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 1 });
  });

  it('TC-USG-016 cancel RETRY_WAIT after image usage was committed does not release it twice', async () => {
    await enableImage();
    sendPhoto.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 60),
    );
    await app.get(PublishingService).publish(publicationA);
    const response = await call('POST', `/api/v1/publications/${publicationA}/cancel`);
    await observe('TC-USG-016', { httpStatus: response.status });
    expect(response.status).toBeLessThan(300);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('CANCELLED');
    expect(
      (await usage.summary(a)).items.find((item) => item.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 1 });
  });

  it('TC-SCH-017 FIRE_ONCE outside its grace period is skipped without paid work', async () => {
    const now = new Date('2026-10-17T10:00:00Z');
    const runAt = new Date(now.getTime() - 25 * 3600000);
    await prisma.postSchedule.update({ where: { id: scheduleB }, data: { status: 'PAUSED' } });
    const schedule = await prisma.postSchedule.create({
      data: {
        postId: postA,
        kind: 'ONCE',
        timezone: 'UTC',
        runAt,
        nextRunAt: runAt,
        misfirePolicy: 'FIRE_ONCE',
        misfireGraceSeconds: 86400,
      },
    });
    await app.get(SchedulesService).materializeDue(now);
    const occurrence = await prisma.publication.findFirstOrThrow({
      where: { scheduleId: schedule.id },
    });
    await observe('TC-SCH-017', {
      occurrenceStatus: occurrence.status,
      outboxCount: await prisma.outboxEvent.count({ where: { aggregateId: occurrence.id } }),
    });
    expect(occurrence.status).toBe('SKIPPED');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: occurrence.id } })).toBe(0);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });

  // Third tranche: independent subscription, usage and post contracts.
  async function freeA() {
    await prisma.subscription.deleteMany({ where: { userId: a } });
  }
  async function patchPro(values: Record<string, unknown>) {
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'pro' } });
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        entitlements: { ...(plan.entitlements as Record<string, unknown>), ...values } as never,
      },
    });
  }
  function reserveText(key = randomUUID(), at?: Date) {
    return usage.reserve({
      userId: a,
      metric: 'TEXT_GENERATION',
      amount: 1,
      operationKey: key,
      ...(at ? { at } : {}),
    });
  }
  async function textCounter() {
    return (await usage.summary(a)).items.find((x) => x.metric === 'TEXT_GENERATION');
  }
  async function immediate(id = postA, key = randomUUID()) {
    const r = await call('POST', `/api/v1/posts/${id}/publications`).set('Idempotency-Key', key);
    expect(r.status).toBe(202);
    return responseBody(r).data.id;
  }
  it('TC-SUB-001 no subscription selects free with exact version-controlled limits', async () => {
    await freeA();
    const r = await call('GET', '/api/v1/subscription').expect(200);
    expect(responseBody(r).data).toMatchObject({
      planCode: 'free',
      subscriptionId: null,
      entitlements: {
        channelLimit: 1,
        topicLimit: 3,
        textGenerationMonthly: 30,
        imageGenerationEnabled: false,
        moderationEnabled: false,
      },
    });
  });
  it('TC-SUB-002 active pro allows expensive post definition without provider side effects', async () => {
    expect(responseBody(await call('GET', '/api/v1/subscription').expect(200)).data.planCode).toBe(
      'pro',
    );
    await call('POST', '/api/v1/posts', {
      channelId: channelA,
      prompt: 'test',
      publicationMode: 'MODERATION',
      generateImage: true,
    }).expect(201);
    expect(text).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });
  it('TC-SUB-003 effective trial uses pro entitlements', async () => {
    await prisma.subscription.updateMany({ where: { userId: a }, data: { status: 'TRIALING' } });
    expect(responseBody(await call('GET', '/api/v1/subscription').expect(200)).data).toMatchObject({
      planCode: 'pro',
      status: 'TRIALING',
    });
  });
  it('TC-SUB-004 future subscription switches at exact startsAt', async () => {
    const now = new Date();
    await prisma.subscription.updateMany({
      where: { userId: a },
      data: { startsAt: new Date(now.getTime() + 60000) },
    });
    expect((await app.get(EntitlementService).resolve(a)).planCode).toBe('free');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now.getTime() + 60000));
    try {
      expect((await app.get(EntitlementService).resolve(a)).planCode).toBe('pro');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['past', 'equal'])('TC-SUB-005 expiry %s rejects expensive work', async (variant) => {
    const now = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      await prisma.subscription.updateMany({
        where: { userId: a },
        data: { endsAt: new Date(now.getTime() - (variant === 'past' ? 1000 : 0)) },
      });
      expect(
        responseBody(await call('GET', '/api/v1/subscription').expect(200)).data.planCode,
      ).toBe('free');
      await call('POST', '/api/v1/posts', {
        channelId: channelA,
        prompt: 'test',
        publicationMode: 'AUTO',
        generateImage: true,
      }).expect(403);
      expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['CANCELLED', 'PAST_DUE'] as const)(
    'TC-SUB-006 %s grants no pro access',
    async (status) => {
      await prisma.subscription.updateMany({ where: { userId: a }, data: { status } });
      expect(
        responseBody(await call('GET', '/api/v1/subscription').expect(200)).data.planCode,
      ).toBe('free');
    },
  );
  it('TC-SUB-008 repeated startup provisioning is idempotent', async () => {
    const before = await prisma.subscriptionPlan.findMany({ orderBy: { code: 'asc' } });
    for (let i = 0; i < 3; i++) await app.get(PlanProvisioningService).onModuleInit();
    const after = await prisma.subscriptionPlan.findMany({ orderBy: { code: 'asc' } });
    expect(after.map((x) => [x.id, x.code, x.entitlements])).toEqual(
      before.map((x) => [x.id, x.code, x.entitlements]),
    );
  });
  it.each(['inactive', 'invalid'])('TC-SUB-009 %s plan never increases rights', async (variant) => {
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'pro' } });
    await prisma.subscriptionPlan.update({
      where: { id: pro.id },
      data:
        variant === 'inactive'
          ? { isActive: false }
          : { entitlements: { imageGenerationEnabled: true } },
    });
    const r = await call('POST', '/api/v1/posts', {
      channelId: channelA,
      prompt: 'test',
      publicationMode: 'AUTO',
      generateImage: true,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
  });
  it('TC-SUB-010 downgrade preserves old resources but rejects growth beyond free limit', async () => {
    await prisma.channel.create({
      data: { userId: a, telegramChatId: -100333n, title: 'Extra', status: 'ACTIVE' },
    });
    await freeA();
    const r = await call('GET', '/api/v1/channels').expect(200);
    expect((r.body as { data: unknown[] }).data).toHaveLength(2);
    await call('POST', '/api/v1/channels', { telegramChatId: '-100444' }).expect(403);
    expect(await prisma.channel.count({ where: { userId: a } })).toBe(2);
  });
  it.each(['free', 'pro'])('TC-SUB-011 exact %s channel capacity', async (plan) => {
    if (plan === 'free') await freeA();
    const limit = plan === 'free' ? 1 : 10;
    for (let i = 1; i < limit; i++)
      await call('POST', '/api/v1/channels', { telegramChatId: String(-100500 - i) }).expect(201);
    await call('POST', '/api/v1/channels', { telegramChatId: '-100999' }).expect(403);
    expect(await prisma.channel.count({ where: { userId: a } })).toBe(limit);
  });
  it.each(['free', 'pro'])('TC-SUB-012 exact %s topic capacity and archived slot', async (plan) => {
    if (plan === 'free') await freeA();
    const limit = plan === 'free' ? 3 : 50;
    for (let i = 1; i < limit; i++)
      await call('POST', '/api/v1/topics', { name: `T${i}`, promptTemplate: 'test' }).expect(201);
    await call('POST', '/api/v1/topics', { name: 'overflow', promptTemplate: 'test' }).expect(403);
    await call('DELETE', `/api/v1/topics/${topicA}`).expect(204);
    await call('POST', '/api/v1/topics', { name: 'replacement', promptTemplate: 'test' }).expect(
      201,
    );
    expect(await prisma.topic.count({ where: { userId: a, status: 'ACTIVE' } })).toBe(limit);
  });
  it('TC-SUB-013 twenty concurrent requests for last topic slot never exceed capacity', async () => {
    await patchPro({ topicLimit: 2 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', '/api/v1/topics', { name: `Concurrent${i}`, promptTemplate: 'test' }),
      ),
    );
    console.info(
      'ACCEPTANCE_EVIDENCE ' +
        JSON.stringify({ caseId: 'TC-SUB-013', statuses: results.map((r) => r.status) }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 403)).toBe(true);
    expect(await prisma.topic.count({ where: { userId: a, status: 'ACTIVE' } })).toBe(2);
  });
  it.each([null, 0])('TC-SUB-014 quota %s is unlimited or denies spend', async (quota) => {
    await patchPro({ textGenerationMonthly: quota });
    if (quota === null) {
      await usage.reserve({
        userId: a,
        metric: 'TEXT_GENERATION',
        amount: 1001,
        operationKey: randomUUID(),
      });
      expect(await textCounter()).toMatchObject({ reserved: 1001, committed: 0, limit: null });
    } else {
      await expect(reserveText()).rejects.toMatchObject({ status: 403 });
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    }
  });
  it('TC-SUB-015 planCode cannot be assigned through public DTO', async () => {
    await freeA();
    await call('POST', '/api/v1/posts', {
      channelId: channelA,
      prompt: 'test',
      publicationMode: 'AUTO',
      planCode: 'pro',
    }).expect(400);
    expect((await app.get(EntitlementService).resolve(a)).planCode).toBe('free');
    expect(await prisma.subscription.count({ where: { userId: a } })).toBe(0);
  });
  it('TC-USG-001 reserve changes exactly one counter and ledger entry', async () => {
    await reserveText();
    expect(await textCounter()).toMatchObject({ reserved: 1, committed: 0 });
    expect(await prisma.usageLedgerEntry.count()).toBe(1);
  });
  it('TC-USG-002 commit atomically moves reserved usage', async () => {
    await reserveText();
    await usage.commit({
      userId: a,
      metric: 'TEXT_GENERATION',
      amount: 1,
      operationKey: randomUUID(),
    });
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 1 });
    expect(await prisma.usageLedgerEntry.count()).toBe(2);
  });
  it('TC-USG-003 release returns reserved quota without committing', async () => {
    await reserveText();
    await usage.release({
      userId: a,
      metric: 'TEXT_GENERATION',
      amount: 1,
      operationKey: randomUUID(),
    });
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
    expect(await prisma.usageLedgerEntry.count()).toBe(2);
  });
  it.each(['reserve', 'commit', 'release'] as const)(
    'TC-USG-004 repeat %s is idempotent',
    async (kind) => {
      if (kind !== 'reserve') await reserveText();
      const input = {
        userId: a,
        metric: 'TEXT_GENERATION' as const,
        amount: 1,
        operationKey: randomUUID(),
      };
      await usage[kind](input);
      const before = await prisma.usageCounter.findMany();
      const count = await prisma.usageLedgerEntry.count();
      await usage[kind](input);
      expect(await prisma.usageCounter.findMany()).toEqual(before);
      expect(await prisma.usageLedgerEntry.count()).toBe(count);
    },
  );
  it.each(['amount', 'kind'])(
    'TC-USG-005 reused key with changed %s is rejected',
    async (variant) => {
      const key = randomUUID();
      await reserveText(key);
      const input = {
        userId: a,
        metric: 'TEXT_GENERATION' as const,
        amount: variant === 'amount' ? 2 : 1,
        operationKey: key,
      };
      await expect(
        variant === 'amount' ? usage.reserve(input) : usage.commit(input),
      ).rejects.toMatchObject({ status: 409 });
      expect(await textCounter()).toMatchObject({ reserved: 1, committed: 0 });
      expect(await prisma.usageLedgerEntry.count()).toBe(1);
    },
  );
  it.each(['commit', 'release'] as const)(
    'TC-USG-006 %s without reservation never makes counters negative',
    async (kind) => {
      await expect(
        usage[kind]({
          userId: a,
          metric: 'TEXT_GENERATION',
          amount: 1,
          operationKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.usageCounter.count()).toBe(0);
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    },
  );
  it.each([0, -1, 0.5, NaN, Infinity])(
    'TC-USG-007 invalid amount %s has no writes',
    async (amount) => {
      await expect(
        usage.reserve({ userId: a, metric: 'TEXT_GENERATION', amount, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ status: 422 });
      expect(await prisma.usageCounter.count()).toBe(0);
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    },
  );
  it('TC-USG-008 twenty reservations race for last unit without overspending', async () => {
    await patchPro({ textGenerationMonthly: 1 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveText()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await textCounter()).toMatchObject({ reserved: 1, committed: 0 });
    expect(await prisma.usageLedgerEntry.count()).toBe(1);
  });
  it('TC-USG-009 outbox insertion failure rolls back publication and reservation', async () => {
    const originalReserve = usage.reserve.bind(usage);
    const spy = vi.spyOn(usage, 'reserve').mockImplementation(async (input) => {
      await originalReserve(input);
      throw new Error('Injected failure at reservation boundary');
    });
    try {
      await call('POST', `/api/v1/posts/${postA}/publications`).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.publication.count({ where: { postId: postA } })).toBe(1);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
  it('TC-USG-017 UTC monthly boundaries assign new reservations to correct period', async () => {
    const end = new Date('2026-10-31T23:59:59Z');
    const start = new Date('2026-11-01T00:00:00Z');
    await reserveText(randomUUID(), end);
    await reserveText(randomUUID(), start);
    const counters = await prisma.usageCounter.findMany({
      where: { userId: a },
      orderBy: { periodStart: 'asc' },
    });
    expect(counters.map((x) => [x.periodStart.toISOString(), x.reserved])).toEqual([
      ['2026-10-01T00:00:00.000Z', 1],
      ['2026-11-01T00:00:00.000Z', 1],
    ]);
  });
  it.each(['success', 'failure', 'manual-retry'])(
    'TC-USG-018 cross-month %s settles original reservation',
    async (variant) => {
      const id = await immediate();
      const october = new Date('2026-10-01T00:00:00Z');
      const november = new Date('2026-11-01T00:00:00Z');
      await prisma.usageCounter.updateMany({
        where: { userId: a },
        data: { periodStart: october, periodEnd: november },
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
      try {
        if (variant === 'success') await app.get(GenerationService).generate(id);
        else {
          text.mockRejectedValueOnce(
            new TextGenerationProviderError('AI_PROVIDER_INVALID_RESPONSE', false),
          );
          await app.get(GenerationService).generate(id);
        }
        if (variant === 'manual-retry') {
          await call('POST', `/api/v1/publications/${id}/retry`).expect(202);
          await app.get(GenerationService).generate(id);
        }
        const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
        const counters = await prisma.usageCounter.findMany({ where: { userId: a } });
        console.info(
          'ACCEPTANCE_EVIDENCE ' +
            JSON.stringify({
              caseId: 'TC-USG-018',
              variant,
              status: p.status,
              counters: counters.map((x) => ({
                periodStart: x.periodStart,
                reserved: x.reserved,
                committed: x.committed,
              })),
            }),
        );
        expect(
          counters.find((x) => x.periodStart.toISOString() === october.toISOString())?.reserved,
        ).toBe(0);
        expect(p.status).toBe(variant === 'failure' ? 'FAILED' : 'READY');
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('TC-USG-019 usage HTTP summary exposes only safe current accounting fields', async () => {
    await reserveText();
    const r = await call('GET', '/api/v1/usage').expect(200);
    expect(responseBody(r).data).toMatchObject({
      periodStart: usage.period().start.toISOString(),
      periodEnd: usage.period().end.toISOString(),
    });
    expect(responseBody(r).data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'TEXT_GENERATION',
          reserved: 1,
          committed: 0,
          limit: 1000,
        }),
      ]),
    );
    expect(JSON.stringify(r.body)).not.toMatch(/secret|providerRequest|prompt/);
  });
  it('TC-USG-020 repeat published job has no quota or Telegram side effects', async () => {
    const id = await immediate();
    await app.get(GenerationService).generate(id);
    await app.get(PublishingService).publish(id);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PUBLISHED',
    );
    const before = await prisma.usageCounter.findMany();
    const ledger = await prisma.usageLedgerEntry.count();
    await app.get(GenerationService).generate(id, true);
    await app.get(PublishingService).publish(id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await prisma.usageCounter.findMany()).toEqual(before);
    expect(await prisma.usageLedgerEntry.count()).toBe(ledger);
  });
  it('TC-USG-021 ledger sums reconcile per metric and period', async () => {
    for (const metric of ['TEXT_GENERATION', 'IMAGE_GENERATION', 'MODERATION_REVISION'] as const) {
      await usage.reserve({ userId: a, metric, amount: 3, operationKey: randomUUID() });
      await usage.commit({ userId: a, metric, amount: 1, operationKey: randomUUID() });
      await usage.release({ userId: a, metric, amount: 1, operationKey: randomUUID() });
    }
    const counters = await prisma.usageCounter.findMany({
      where: { userId: a },
      include: { ledgerEntries: true },
    });
    for (const c of counters) {
      let reserved = 0,
        committed = 0;
      for (const e of c.ledgerEntries) {
        reserved += e.kind === 'RESERVE' ? e.amount : -e.amount;
        if (e.kind === 'COMMIT') committed += e.amount;
      }
      expect(c.reserved).toBe(reserved);
      expect(c.committed).toBe(committed);
    }
  });
  it('TC-USG-022 failed ledger insertion rolls back counter increment', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const create = vi
          .spyOn(tx.usageLedgerEntry, 'create')
          .mockRejectedValueOnce(new Error('Injected ledger write failure'));
        try {
          await usage.reserve({
            userId: a,
            metric: 'TEXT_GENERATION',
            amount: 1,
            operationKey: randomUUID(),
            database: tx,
          });
        } finally {
          create.mockRestore();
        }
      }),
    ).rejects.toThrow('Injected ledger write failure');
    expect(await prisma.usageCounter.count()).toBe(0);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });
  it.each(['TC-PST-001', 'TC-PST-002', 'TC-PST-003', 'TC-PST-004'])(
    '%s definition persists without generating or charging',
    async (id) => {
      const payload = {
        channelId: channelA,
        prompt: 'test',
        publicationMode: id === 'TC-PST-004' ? 'MODERATION' : 'AUTO',
        generateImage: id === 'TC-PST-003',
      };
      const r = await call('POST', '/api/v1/posts', payload).expect(201);
      const p = await prisma.post.findUniqueOrThrow({ where: { id: responseBody(r).data.id } });
      expect(p).toMatchObject({ ...payload, userId: a, status: 'ACTIVE' });
      expect(await prisma.publication.count({ where: { postId: p.id } })).toBe(0);
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(text).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(sendPhoto).not.toHaveBeenCalled();
    },
  );
  it('TC-PST-005 free moderation refusal leaves no partial record', async () => {
    await freeA();
    await call('POST', '/api/v1/posts', {
      channelId: channelA,
      prompt: 'test',
      publicationMode: 'MODERATION',
    }).expect(403);
    expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });
  it.each(['create', 'patch'])(
    'TC-PST-006 free image %s cannot bypass entitlements',
    async (variant) => {
      await freeA();
      const payload = {
        channelId: channelA,
        topicId: topicA,
        title: 'test',
        prompt: 'test',
        publicationMode: 'AUTO',
        generateImage: true,
      };
      await call(
        variant === 'create' ? 'POST' : 'PATCH',
        variant === 'create' ? '/api/v1/posts' : `/api/v1/posts/${postA}`,
        payload,
      ).expect(403);
      expect((await prisma.post.findUniqueOrThrow({ where: { id: postA } })).generateImage).toBe(
        false,
      );
      expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
    },
  );
  it.each(['omitted', 'null', 'own'])(
    'TC-PST-007 optional topic %s is supported',
    async (variant) => {
      const r = await call('POST', '/api/v1/posts', {
        channelId: channelA,
        prompt: 'test',
        publicationMode: 'AUTO',
        ...(variant === 'omitted' ? {} : { topicId: variant === 'null' ? null : topicA }),
      }).expect(201);
      expect(responseBody(r).data.topicId).toBe(variant === 'own' ? topicA : null);
    },
  );
  it.each(['prompt', 'title', 'topicId', 'publicationMode', 'generateImage'])(
    'TC-PST-008 single-field %s edit preserves all other definition fields',
    async (field) => {
      const values: Record<string, unknown> = {
        prompt: 'updated',
        title: 'updated',
        topicId: null,
        publicationMode: 'MODERATION',
        generateImage: true,
      };
      const before = await prisma.post.findUniqueOrThrow({ where: { id: postA } });
      const r = await call('PATCH', `/api/v1/posts/${postA}`, { [field]: values[field] });
      console.info(
        'ACCEPTANCE_EVIDENCE ' + JSON.stringify({ caseId: 'TC-PST-008', field, status: r.status }),
      );
      expect(r.status).toBe(200);
      const after = await prisma.post.findUniqueOrThrow({ where: { id: postA } });
      expect(after.version).toBe(2);
      expect(after[field as keyof typeof after]).toEqual(values[field]);
      for (const other of Object.keys(values).filter((x) => x !== field))
        expect(after[other as keyof typeof after]).toEqual(before[other as keyof typeof before]);
    },
  );
  it('TC-PST-009 full PATCH cannot move post to foreign channel', async () => {
    const r = await call('PATCH', `/api/v1/posts/${postA}`, {
      channelId: channelB,
      topicId: topicA,
      title: null,
      prompt: 'test',
      publicationMode: 'AUTO',
      generateImage: false,
    });
    expect([403, 404, 422]).toContain(r.status);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postA } })).channelId).toBe(
      channelA,
    );
  });
  it('TC-PST-010 materialized work cannot silently change target or approved definition', async () => {
    const id = await immediate();
    const other = await prisma.channel.create({
      data: { userId: a, telegramChatId: -100777n, title: 'other', status: 'ACTIVE' },
    });
    await call('PATCH', `/api/v1/posts/${postA}`, {
      channelId: other.id,
      topicId: null,
      title: 'changed',
      prompt: 'changed',
      publicationMode: 'MODERATION',
      generateImage: true,
    }).expect(200);
    await app.get(GenerationService).generate(id);
    const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
    console.info(
      'ACCEPTANCE_EVIDENCE ' +
        JSON.stringify({
          caseId: 'TC-PST-010',
          status: p.status,
          usedOriginalPrompt: text.mock.calls[0]?.[0]?.prompt === 'original',
          maxCharacters: text.mock.calls[0]?.[0]?.maxCharacters,
        }),
    );
    expect(text.mock.calls[0]?.[0]).toMatchObject({ prompt: 'original', maxCharacters: 4096 });
    expect(p.status).toBe('READY');
    await app.get(PublishingService).publish(id);
    expect(sendText.mock.calls[0]?.[0]).toBe(-100111n);
  });
  it('TC-PST-011 archive preserves readable versions and publications', async () => {
    await call('DELETE', `/api/v1/posts/${postA}`).expect(204);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postA } })).status).toBe('ARCHIVED');
    await call('GET', `/api/v1/posts/${postA}`).expect(200);
    expect(
      (
        (await call('GET', `/api/v1/posts/${postA}/versions`).expect(200)).body as {
          data: unknown[];
        }
      ).data,
    ).toHaveLength(1);
    await call('GET', `/api/v1/publications/${publicationA}`).expect(200);
  });
  it('TC-PST-012 archived post cannot create paid work', async () => {
    await call('DELETE', `/api/v1/posts/${postA}`).expect(204);
    await call('POST', `/api/v1/posts/${postA}/publications`).set('If-Match', '"2"').expect(409);
    expect(await prisma.publication.count({ where: { postId: postA } })).toBe(1);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
  it('TC-PST-014 explicit publication creates atomic occurrence reservation and outbox', async () => {
    const id = await immediate();
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect(await textCounter()).toMatchObject({ reserved: 1, committed: 0 });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: id } })).toBe(1);
    expect(text).not.toHaveBeenCalled();
  });
  it('TC-PST-015 repeat command key returns same occurrence with no duplicate accounting', async () => {
    const key = randomUUID();
    const id = await immediate(postA, key);
    expect(await immediate(postA, key)).toBe(id);
    expect(await prisma.publication.count({ where: { postId: postA } })).toBe(2);
    expect(await prisma.usageLedgerEntry.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });
  it('TC-PST-016 distinct command keys create independent occurrences', async () => {
    const first = await immediate();
    const second = await immediate();
    expect(first).not.toBe(second);
    expect(await textCounter()).toMatchObject({ reserved: 2, committed: 0 });
    expect(await prisma.outboxEvent.count()).toBe(2);
  });
  it('TC-PST-018 definition and topic edits plus job redelivery preserve final version', async () => {
    const before = await prisma.postVersion.findMany({ where: { postId: postA } });
    await call('PATCH', `/api/v1/posts/${postA}`, {
      channelId: channelA,
      topicId: topicA,
      title: 'new',
      prompt: 'changed',
      publicationMode: 'AUTO',
      generateImage: false,
    }).expect(200);
    await call('PATCH', `/api/v1/topics/${topicA}`, {
      name: 'new',
      promptTemplate: 'changed',
    }).expect(200);
    await app.get(GenerationService).generate(publicationA, true);
    expect(await prisma.postVersion.findMany({ where: { postId: postA } })).toEqual(before);
  });
  it('TC-PST-019 parallel occurrences get distinct correct immutable version sequences', async () => {
    const ids = await Promise.all([immediate(), immediate()]);
    await Promise.all(ids.map((id) => app.get(GenerationService).generate(id)));
    const versions = await prisma.postVersion.findMany({ where: { publicationId: { in: ids } } });
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((v) => v.sequence)).size).toBe(2);
    for (const id of ids) {
      const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
      expect(versions.find((v) => v.publicationId === id)?.id).toBe(p.selectedVersionId);
      expect(p.status).toBe('READY');
    }
  });
  it.each(['channel', 'topic'])(
    'TC-PST-020 nonexistent %s is rejected without effects',
    async (field) => {
      await call('POST', '/api/v1/posts', {
        channelId: field === 'channel' ? randomUUID() : channelA,
        topicId: field === 'topic' ? randomUUID() : topicA,
        prompt: 'test',
        publicationMode: 'AUTO',
      }).expect(422);
      expect(await prisma.post.count({ where: { userId: a } })).toBe(1);
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    },
  );

  const pageResources = [
    'channels',
    'topics',
    'posts',
    'versions',
    'publications',
    'moderation',
    'schedules',
  ] as const;
  type PageResource = (typeof pageResources)[number];
  function listPath(resource: PageResource) {
    return resource === 'versions' ? `/api/v1/posts/${postA}/versions` : `/api/v1/${resource}`;
  }
  type PageBody = {
    data: Array<{ id: string; status?: string; channelId?: string; postId?: string }>;
    page: { hasMore: boolean; nextCursor: string | null };
  };
  async function page(resource: PageResource, query = '') {
    const r = await call('GET', listPath(resource) + query).expect(200);
    return r.body as PageBody;
  }
  async function populatePages(
    resource: PageResource,
    count = 30,
    createdAt = new Date('2026-01-01T00:00:00Z'),
  ) {
    const sequenceBase =
      (await prisma.postVersion.aggregate({ where: { postId: postA }, _max: { sequence: true } }))
        ._max.sequence ?? 0;
    const chatBase = BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 10));
    const ids = Array.from({ length: count }, () => randomUUID());
    if (resource === 'channels')
      await prisma.channel.createMany({
        data: ids.map((id, i) => ({
          id,
          userId: a,
          telegramChatId: -chatBase - BigInt(i),
          title: 'Paged',
          status: 'ACTIVE' as const,
          createdAt,
        })),
      });
    if (resource === 'topics')
      await prisma.topic.createMany({
        data: ids.map((id) => ({
          id,
          userId: a,
          name: 'Paged ' + id,
          promptTemplate: 'test',
          createdAt,
        })),
      });
    if (resource === 'posts')
      await prisma.post.createMany({
        data: ids.map((id) => ({
          id,
          userId: a,
          channelId: channelA,
          prompt: 'test',
          publicationMode: 'AUTO' as const,
          status: 'ACTIVE' as const,
          createdAt,
        })),
      });
    if (resource === 'versions')
      await prisma.postVersion.createMany({
        data: ids.map((id, i) => ({
          id,
          postId: postA,
          publicationId: publicationA,
          sequence: i + sequenceBase + 1,
          status: 'GENERATED' as const,
          text: 'final',
          createdAt,
        })),
      });
    if (resource === 'publications')
      await prisma.publication.createMany({
        data: ids.map((id) => ({
          id,
          postId: postA,
          status: 'PENDING' as const,
          scheduledFor: new Date(0),
          createdAt,
        })),
      });
    if (resource === 'schedules')
      await prisma.postSchedule.createMany({
        data: ids.map((id) => ({
          id,
          postId: postA,
          kind: 'ONCE' as const,
          timezone: 'UTC',
          misfirePolicy: 'FIRE_ONCE' as const,
          misfireGraceSeconds: 86400,
          runAt: new Date('2030-01-01Z'),
          nextRunAt: new Date('2030-01-01Z'),
          createdAt,
        })),
      });
    if (resource === 'moderation') {
      await prisma.postVersion.createMany({
        data: ids.map((id, i) => ({
          id,
          postId: postA,
          publicationId: publicationA,
          sequence: i + sequenceBase + 1,
          status: 'GENERATED' as const,
          text: 'final',
          createdAt,
        })),
      });
      await prisma.moderationRequest.createMany({
        data: ids.map((versionId) => ({
          postId: postA,
          publicationId: publicationA,
          versionId,
          createdAt,
        })),
      });
    }
  }
  it.each(pageResources)('TC-PAGE-001 empty %s list has stable page flags', async (resource) => {
    // A third user with an owned post is independent of A/B baseline fixtures.
    const c = await app.get(IdentityService).resolveBotUser({ telegramUserId: '930001' });
    const channel = await prisma.channel.create({
      data: { userId: c.id, telegramChatId: -300001n, title: 'C', status: 'ACTIVE' },
    });
    const post = await prisma.post.create({
      data: {
        userId: c.id,
        channelId: channel.id,
        prompt: 'test',
        publicationMode: 'AUTO',
        status: 'ACTIVE',
      },
    });
    // Channels/posts are made empty by archive, which remains excluded by default.
    await prisma.channel.update({ where: { id: channel.id }, data: { status: 'ARCHIVED' } });
    await prisma.post.update({ where: { id: post.id }, data: { status: 'ARCHIVED' } });
    const path =
      resource === 'versions' ? `/api/v1/posts/${post.id}/versions` : `/api/v1/${resource}`;
    const r = await request(app.getHttpServer())
      .get(path)
      .set(headers('GET', path, '', '930001'))
      .expect(200);
    expect(r.body).toMatchObject({ data: [], page: { hasMore: false, nextCursor: null } });
  });
  it.each(pageResources)('TC-PAGE-002 %s defaults to 25 with next cursor', async (resource) => {
    await populatePages(resource);
    const p = await page(resource);
    expect(p.data).toHaveLength(25);
    expect(p.page.hasMore).toBe(true);
    expect(typeof p.page.nextCursor).toBe('string');
  });
  it.each(pageResources)('TC-PAGE-003 %s limit one', async (resource) => {
    await populatePages(resource, 2);
    const p = await page(resource, '?limit=1');
    expect(p.data).toHaveLength(1);
    expect(p.page.hasMore).toBe(true);
    expect(p.page.nextCursor).toBeTruthy();
  });
  for (const resource of pageResources.filter((r) => r !== 'publications'))
    it.each([0, 1, 100, 101, -1, 1.5, 'text'])(
      'TC-PAGE-004 ' + resource + ' limit %s boundary',
      async (limit) => {
        const r = await call('GET', listPath(resource) + `?limit=${limit}`);
        expect(r.status).toBe(limit === 1 || limit === 100 ? 200 : 400);
      },
    );
  for (const caseId of ['TC-PAGE-005', 'TC-PAGE-006', 'TC-PAGE-007'])
    it.each(pageResources)(
      caseId + ' %s traversal is complete unique and terminates',
      async (resource) => {
        await populatePages(resource, caseId === 'TC-PAGE-006' ? 29 : 30);
        const all = await page(resource, '?limit=100');
        const seen: string[] = [];
        let cursor: string | null = null;
        let iterations = 0;
        do {
          const p = await page(
            resource,
            `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          seen.push(...p.data.map((x) => x.id));
          cursor = p.page.nextCursor;
          expect(p.page.hasMore).toBe(cursor !== null);
          iterations++;
          expect(iterations).toBeLessThan(10);
        } while (cursor);
        expect(seen).toEqual(all.data.map((x) => x.id));
        expect(new Set(seen).size).toBe(seen.length);
      },
    );
  it.each(pageResources)(
    'TC-PAGE-008 %s insertion between pages cannot duplicate existing data',
    async (resource) => {
      await populatePages(resource, 4);
      const before = await page(resource, '?limit=100');
      const first = await page(resource, '?limit=2');
      await populatePages(resource, 1, new Date(Date.now() + 1000));
      const second = await page(
        resource,
        `?limit=100&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
      );
      const combined = [...first.data, ...second.data].map((x) => x.id);
      expect(new Set(combined).size).toBe(combined.length);
      for (const row of before.data) expect(combined).toContain(row.id);
    },
  );
  it.each(['channels', 'topics', 'posts', 'schedules'] as const)(
    'TC-PAGE-009 %s archived cursor row does not cause 500',
    async (resource) => {
      await populatePages(resource, 4);
      const first = await page(resource, '?limit=1');
      const id = first.data[0]!.id;
      if (resource === 'channels')
        await prisma.channel.update({ where: { id }, data: { status: 'ARCHIVED' } });
      if (resource === 'topics')
        await prisma.topic.update({ where: { id }, data: { status: 'ARCHIVED' } });
      if (resource === 'posts')
        await prisma.post.update({ where: { id }, data: { status: 'ARCHIVED' } });
      if (resource === 'schedules')
        await prisma.postSchedule.update({ where: { id }, data: { status: 'CANCELLED' } });
      const second = await page(
        resource,
        `?limit=100&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
      );
      expect(second.data.map((x) => x.id)).not.toContain(id);
    },
  );
  for (const resource of pageResources)
    it.each([
      'not-json',
      Buffer.from(JSON.stringify({ createdAt: 'invalid', id: randomUUID() })).toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: '2026-01-01Z' })).toString('base64url'),
    ])('TC-PAGE-010 ' + resource + ' invalid cursor %s', async (cursor) => {
      const r = await call(
        'GET',
        listPath(resource) + `?cursor=${encodeURIComponent(cursor)}`,
      ).expect(400);
      expect(responseBody(r).error.code).toBe('INVALID_CURSOR');
    });
  for (const resource of pageResources)
    it.each([1024, 1025])(
      'TC-PAGE-011 ' + resource + ' cursor length %s bounded',
      async (length) => {
        const r = await call('GET', listPath(resource) + `?cursor=${'x'.repeat(length)}`).expect(
          400,
        );
        expect(responseBody(r).error.code).toBe(length === 1024 ? 'INVALID_CURSOR' : 'BAD_REQUEST');
      },
    );
  it.each(pageResources)(
    'TC-PAGE-012 %s foreign cursor cannot broaden ownership',
    async (resource) => {
      await populatePages(resource, 3);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: new Date('2030-01-01Z').toISOString(), id: postB }),
      ).toString('base64url');
      const regular = await page(resource, '?limit=100');
      const foreign = await page(resource, `?limit=100&cursor=${cursor}`);
      expect(foreign.data.map((x) => x.id)).toEqual(regular.data.map((x) => x.id));
      expect(foreign.data.map((x) => x.id)).not.toEqual(
        expect.arrayContaining([channelB, topicB, postB, publicationB, moderationB, scheduleB]),
      );
    },
  );
  it.each(['posts', 'publications'])(
    'TC-PAGE-014 %s foreign resource filter never reveals records',
    async (resource) => {
      const p = await page(
        resource as PageResource,
        resource === 'posts' ? `?channelId=${channelB}` : `?postId=${postB}`,
      );
      expect(p.data).toEqual([]);
    },
  );

  async function review(image = false) {
    await prisma.post.update({
      where: { id: postA },
      data: { publicationMode: 'MODERATION', generateImage: image },
    });
    const id = await immediate();
    await app.get(GenerationService).generate(id);
    const mod = await prisma.moderationRequest.findFirstOrThrow({
      where: { publicationId: id, status: 'PENDING' },
    });
    return { id, mod };
  }
  it('TC-MOD-001 generated moderation content waits without image or Telegram', async () => {
    const { id, mod } = await review(true);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'AWAITING_MODERATION',
    );
    expect(mod.status).toBe('PENDING');
    expect(await prisma.moderationRequest.count({ where: { publicationId: id } })).toBe(1);
    expect(generateImage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  });
  it('TC-MOD-003 approval selects final version and publishes exactly once', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/approve`).expect(202);
    const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: 'READY', selectedVersionId: mod.versionId });
    await app.get(PublishingService).publish(id);
    await app.get(PublishingService).publish(id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PUBLISHED',
    );
  });
  it('TC-MOD-004 reject cancels publication and releases image quota', async () => {
    const { id, mod } = await review(true);
    await call('POST', `/api/v1/moderation/${mod.id}/reject`).expect(200);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'CANCELLED',
    );
    expect(
      (await prisma.postVersion.findUniqueOrThrow({ where: { id: mod.versionId } })).status,
    ).toBe('REJECTED');
    expect(
      (await usage.summary(a)).items.find((x) => x.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 0 });
    await app.get(PublishingService).publish(id);
    expect(sendPhoto).not.toHaveBeenCalled();
  });
  it('TC-MOD-005 revision supersedes old text and creates durable generation work', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, {
      feedback: 'More examples',
    }).expect(202);
    expect(
      (await prisma.postVersion.findUniqueOrThrow({ where: { id: mod.versionId } })).status,
    ).toBe('SUPERSEDED');
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: id } })).toBe(2);
    await app.get(GenerationService).generate(id);
    expect(await prisma.postVersion.count({ where: { publicationId: id } })).toBe(2);
  });
  it('TC-MOD-006 revision provider receives previous final text and feedback', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, {
      feedback: 'More examples',
    }).expect(202);
    await app.get(GenerationService).generate(id);
    expect(text.mock.calls[1]?.[0]).toMatchObject({
      previousText: 'Test final artifact',
      revisionFeedback: 'More examples',
    });
  });
  it('TC-MOD-007 three sequential revisions preserve history and account every generation', async () => {
    const { id } = await review();
    for (let i = 0; i < 3; i++) {
      const mod = await prisma.moderationRequest.findFirstOrThrow({
        where: { publicationId: id, status: 'PENDING' },
      });
      await call('POST', `/api/v1/moderation/${mod.id}/revision`, {
        feedback: `Change ${i}`,
      }).expect(202);
      await app.get(GenerationService).generate(id);
    }
    const versions = await prisma.postVersion.findMany({
      where: { publicationId: id },
      orderBy: { sequence: 'asc' },
    });
    expect(versions).toHaveLength(4);
    expect(versions.map((x) => x.sequence)).toEqual([2, 3, 4, 5]);
    expect(versions.map((x) => x.status)).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
      'SUPERSEDED',
      'GENERATED',
    ]);
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 4 });
    expect(
      (await usage.summary(a)).items.find((x) => x.metric === 'MODERATION_REVISION'),
    ).toMatchObject({ reserved: 0, committed: 3 });
  });
  it('TC-MOD-008 approval of superseded request cannot publish old text', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' }).expect(202);
    await call('POST', `/api/v1/moderation/${mod.id}/approve`).expect(409);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });
  it('TC-MOD-009 same-key duplicate approval has one delivery', async () => {
    const { id, mod } = await review();
    const key = randomUUID();
    for (let i = 0; i < 2; i++)
      await call('POST', `/api/v1/moderation/${mod.id}/approve`)
        .set('Idempotency-Key', key)
        .expect(202);
    await app.get(PublishingService).publish(id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await prisma.publication.count({ where: { id } })).toBe(1);
  });
  it.each([
    ['TC-MOD-010', 'approve', 'reject'],
    ['TC-MOD-011', 'approve', 'revision'],
    ['TC-MOD-012', 'revision', 'revision'],
  ])('%s concurrent %s versus %s has exactly one decision', async (_id, left, right) => {
    const { id, mod } = await review();
    const results = await Promise.all(
      [left, right].map((action, i) =>
        call(
          'POST',
          `/api/v1/moderation/${mod.id}/${action}`,
          action === 'revision' ? { feedback: `Change ${i}` } : undefined,
        ),
      ),
    );
    expect(results.filter((r) => r.status < 300)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
    expect(['PENDING', 'READY', 'CANCELLED']).toContain(p.status);
    const counter = (await usage.summary(a)).items.find((x) => x.metric === 'MODERATION_REVISION')!;
    expect(counter.committed).toBe(p.status === 'PENDING' ? 1 : 0);
  });
  for (const status of ['CANCELLED', 'PUBLISHING'] as const)
    it.each(['approve', 'revision', 'reject'])(
      (status === 'CANCELLED' ? 'TC-MOD-013' : 'TC-MOD-014') + ' ' + status + ' rejects %s',
      async (action) => {
        const { id, mod } = await review();
        await prisma.publication.update({ where: { id }, data: { status } });
        await call(
          'POST',
          `/api/v1/moderation/${mod.id}/${action}`,
          action === 'revision' ? { feedback: 'Change' } : undefined,
        ).expect(409);
        expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(status);
      },
    );
  it.each([1, 4000, 4001])('TC-MOD-015 feedback length %s', async (length) => {
    const { mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, {
      feedback: 'x'.repeat(length),
    }).expect(length === 4001 ? 400 : 202);
  });
  it.each(['', '   ', null])(
    'TC-MOD-016 unusable feedback %s never queues paid generation',
    async (feedback) => {
      const { id, mod } = await review();
      const before = await prisma.usageLedgerEntry.count();
      const r = await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
        'AWAITING_MODERATION',
      );
      expect(await prisma.usageLedgerEntry.count()).toBe(before);
    },
  );
  it('TC-MOD-017 exhausted revision quota preserves pending decision', async () => {
    const { id, mod } = await review();
    await patchPro({ moderationRevisionMonthly: 0 });
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' }).expect(403);
    expect(
      (await prisma.moderationRequest.findUniqueOrThrow({ where: { id: mod.id } })).status,
    ).toBe('PENDING');
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'AWAITING_MODERATION',
    );
  });
  it('TC-USG-011 replay revision charges one revision and one text generation', async () => {
    const { id, mod } = await review();
    const key = randomUUID();
    for (let i = 0; i < 2; i++)
      await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' })
        .set('Idempotency-Key', key)
        .expect(202);
    await app.get(GenerationService).generate(id);
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 2 });
    expect(
      (await usage.summary(a)).items.find((x) => x.metric === 'MODERATION_REVISION'),
    ).toMatchObject({ reserved: 0, committed: 1 });
  });
  it.each(['text', 'revision'])(
    'TC-USG-012 lacking %s quota rolls back entire revision',
    async (metric) => {
      const { mod } = await review();
      await patchPro(
        metric === 'text' ? { textGenerationMonthly: 1 } : { moderationRevisionMonthly: 0 },
      );
      const before = await prisma.usageLedgerEntry.count();
      await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' }).expect(
        403,
      );
      expect(await prisma.usageLedgerEntry.count()).toBe(before);
      expect(
        (await prisma.moderationRequest.findUniqueOrThrow({ where: { id: mod.id } })).status,
      ).toBe('PENDING');
    },
  );
  it('TC-PST-017 revision history exposes all immutable unique sequences', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' }).expect(202);
    await app.get(GenerationService).generate(id);
    const r = await call('GET', `/api/v1/posts/${postA}/versions`).expect(200);
    const data = (r.body as { data: Array<{ id: string; sequence: number; text: string }> }).data;
    expect(data).toHaveLength(3);
    expect(new Set(data.map((x) => x.sequence)).size).toBe(3);
    expect(data.every((x) => typeof x.text === 'string')).toBe(true);
  });
  it('TC-USG-013 Telegram photo retry never charges image quota twice', async () => {
    await enableImage();
    sendPhoto.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 1),
    );
    await app.get(PublishingService).publish(publicationA);
    await prisma.publication.update({
      where: { id: publicationA },
      data: { nextAttemptAt: new Date(0) },
    });
    await app.get(PublishingService).publish(publicationA);
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('PUBLISHED');
    expect(
      (await usage.summary(a)).items.find((x) => x.metric === 'IMAGE_GENERATION'),
    ).toMatchObject({ reserved: 0, committed: 1 });
  });
  async function ownSchedule(options: Record<string, unknown> = {}) {
    const runAt = new Date(Date.now() + 3600000).toISOString();
    const r = await call('POST', '/api/v1/schedules', {
      postId: postA,
      kind: 'ONCE',
      timezone: 'UTC',
      runAt,
      ...options,
    }).expect(201);
    return responseBody(r).data.id;
  }
  it('TC-SCH-001 one-time schedule stores correct instant without premature occurrence', async () => {
    const runAt = new Date(Date.now() + 3600000).toISOString();
    const id = await ownSchedule({ runAt });
    expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ACTIVE',
      nextRunAt: new Date(runAt),
    });
    await app.get(SchedulesService).materializeDue(new Date());
    expect(await prisma.publication.count({ where: { scheduleId: id } })).toBe(0);
  });
  it.each(['2030-01-01T10:00:00Z', '2030-01-01T13:00:00+03:00', '2030-01-01T05:00:00-05:00'])(
    'TC-SCH-002 offset %s resolves same UTC instant',
    async (runAt) => {
      const id = await ownSchedule({ runAt });
      expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).nextRunAt).toEqual(
        new Date('2030-01-01T10:00:00Z'),
      );
    },
  );
  it('TC-SCH-003 missing UTC offset is rejected', async () => {
    await call('POST', '/api/v1/schedules', {
      postId: postA,
      kind: 'ONCE',
      timezone: 'UTC',
      runAt: '2030-01-01T10:00:00',
    }).expect(422);
    expect(await prisma.postSchedule.count({ where: { postId: postA } })).toBe(0);
  });
  it.each(['2030-02-30T10:00:00Z', 'broken'])(
    'TC-SCH-004 invalid calendar date %s is not silently normalized',
    async (runAt) => {
      const r = await call('POST', '/api/v1/schedules', {
        postId: postA,
        kind: 'ONCE',
        timezone: 'UTC',
        runAt,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await prisma.postSchedule.count({ where: { postId: postA } })).toBe(0);
    },
  );
  it.each(['create', 'update'])(
    'TC-SCH-005 invalid timezone %s has no incorrect persisted instant',
    async (variant) => {
      const id = variant === 'update' ? await ownSchedule() : null;
      const r = await call(
        variant === 'create' ? 'POST' : 'PATCH',
        id ? `/api/v1/schedules/${id}` : '/api/v1/schedules',
        variant === 'create'
          ? { postId: postA, kind: 'ONCE', timezone: 'Invalid/Zone', runAt: '2030-01-01T10:00:00Z' }
          : { timezone: 'Invalid/Zone' },
      );
      expect(r.status).toBeGreaterThanOrEqual(400);
      if (id)
        expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).timezone).toBe(
          'UTC',
        );
    },
  );
  it('TC-SCH-009 future runAt edit changes next date without old materialization', async () => {
    const id = await ownSchedule();
    await call('PATCH', `/api/v1/schedules/${id}`, { runAt: '2030-01-01T10:00:00Z' }).expect(200);
    expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).nextRunAt).toEqual(
      new Date('2030-01-01T10:00:00Z'),
    );
    await app.get(SchedulesService).materializeDue(new Date(Date.now() + 7200000));
    expect(await prisma.publication.count({ where: { scheduleId: id } })).toBe(0);
  });
  it('TC-SCH-011 pause prevents due materialization', async () => {
    const id = await ownSchedule();
    await call('POST', `/api/v1/schedules/${id}/pause`).expect(201);
    await app.get(SchedulesService).materializeDue(new Date(Date.now() + 7200000));
    expect(await prisma.publication.count({ where: { scheduleId: id } })).toBe(0);
    expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
  });
  it('TC-SCH-012 resume returns paused schedule to ACTIVE', async () => {
    const id = await ownSchedule();
    await call('POST', `/api/v1/schedules/${id}/pause`).expect(201);
    await call('POST', `/api/v1/schedules/${id}/resume`).set('If-Match', '"2"').expect(201);
    expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
  });
  it.each(['ACTIVE', 'PAUSED'] as const)(
    'TC-SCH-013 cancel %s schedule prevents occurrences',
    async (status) => {
      const id = await ownSchedule();
      if (status === 'PAUSED')
        await prisma.postSchedule.update({ where: { id }, data: { status } });
      await call('DELETE', `/api/v1/schedules/${id}`).expect(204);
      await app.get(SchedulesService).materializeDue(new Date(Date.now() + 7200000));
      expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).status).toBe(
        'CANCELLED',
      );
      expect(await prisma.publication.count({ where: { scheduleId: id } })).toBe(0);
    },
  );
  it.each(['CANCELLED', 'COMPLETED'] as const)(
    'TC-SCH-015 terminal %s cannot resume',
    async (status) => {
      const id = await ownSchedule();
      await prisma.postSchedule.update({ where: { id }, data: { status } });
      await call('POST', `/api/v1/schedules/${id}/resume`).expect(409);
      expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id } })).status).toBe(status);
    },
  );
  it.each([86399, 86400, 86401])(
    'TC-SCH-018 FIRE_ONCE grace boundary elapsed=%s',
    async (elapsed) => {
      await prisma.postSchedule.update({ where: { id: scheduleB }, data: { status: 'PAUSED' } });
      const now = new Date();
      const runAt = new Date(now.getTime() - elapsed * 1000);
      const s = await prisma.postSchedule.create({
        data: {
          postId: postA,
          kind: 'ONCE',
          timezone: 'UTC',
          runAt,
          nextRunAt: runAt,
          misfirePolicy: 'FIRE_ONCE',
          misfireGraceSeconds: 86400,
        },
      });
      await app.get(SchedulesService).materializeDue(now);
      const p = await prisma.publication.findFirstOrThrow({ where: { scheduleId: s.id } });
      expect(p.status).toBe(elapsed > 86400 ? 'SKIPPED' : 'PENDING');
      expect(await prisma.outboxEvent.count({ where: { aggregateId: p.id } })).toBe(
        elapsed > 86400 ? 0 : 1,
      );
    },
  );
  it('TC-SCH-016 FIRE_ONCE inside grace catches up exactly once', async () => {
    await prisma.postSchedule.update({ where: { id: scheduleB }, data: { status: 'PAUSED' } });
    const now = new Date();
    const runAt = new Date(now.getTime() - 3600000);
    const s = await prisma.postSchedule.create({
      data: {
        postId: postA,
        kind: 'ONCE',
        timezone: 'UTC',
        runAt,
        nextRunAt: runAt,
        misfirePolicy: 'FIRE_ONCE',
        misfireGraceSeconds: 86400,
      },
    });
    for (let i = 0; i < 3; i++) await app.get(SchedulesService).materializeDue(now);
    expect(await prisma.publication.count({ where: { scheduleId: s.id, status: 'PENDING' } })).toBe(
      1,
    );
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await textCounter()).toMatchObject({ reserved: 1, committed: 0 });
  });
  it('TC-SCH-019 SKIP never sends missed occurrence', async () => {
    await prisma.postSchedule.update({ where: { id: scheduleB }, data: { status: 'PAUSED' } });
    const now = new Date();
    const runAt = new Date(now.getTime() - 3600000);
    const s = await prisma.postSchedule.create({
      data: {
        postId: postA,
        kind: 'ONCE',
        timezone: 'UTC',
        runAt,
        nextRunAt: runAt,
        misfirePolicy: 'SKIP',
        misfireGraceSeconds: 86400,
      },
    });
    await app.get(SchedulesService).materializeDue(now);
    const p = await prisma.publication.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(p.status).toBe('SKIPPED');
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });
  it.each(['foreign', 'archived'])('TC-SCH-020 %s post cannot create schedule', async (variant) => {
    if (variant === 'archived')
      await prisma.post.update({ where: { id: postA }, data: { status: 'ARCHIVED' } });
    const r = await call('POST', '/api/v1/schedules', {
      postId: variant === 'foreign' ? postB : postA,
      kind: 'ONCE',
      timezone: 'UTC',
      runAt: '2030-01-01T10:00:00Z',
    });
    expect([403, 404, 409, 422]).toContain(r.status);
    expect(await prisma.postSchedule.count({ where: { postId: postA } })).toBe(0);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });

  async function withQueue<T>(
    work: (
      queue: Queue<PostGenerationJobPayload>,
      dispatcher: OutboxDispatcherService,
    ) => Promise<T>,
  ) {
    const url = new URL(process.env.AUTOBOT_TEST_REDIS_URL!);
    const queue = new Queue<PostGenerationJobPayload>('acceptance-generation', {
      prefix: `autobot:acceptance:${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port), db: 15 },
    });
    const dispatcher = new OutboxDispatcherService(
      prisma,
      app.get<ConfigService<AppEnvironment, true>>(ConfigService),
      queue,
    );
    try {
      return await work(queue, dispatcher);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }
  it('TC-QUE-002 enqueue before outbox acknowledgement reuses deterministic job ID', async () => {
    const id = await immediate();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } });
    await withQueue(async (queue, dispatcher) => {
      await queue.add(
        'generate-post',
        { schemaVersion: 1, publicationId: id },
        { jobId: `generation-${event.id}` },
      );
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 61000) },
      });
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(1);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        'PUBLISHED',
      );
    });
  });
  it('TC-QUE-003 stale outbox lease is reclaimed into real Redis queue', async () => {
    const id = await immediate();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } });
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 61000) },
    });
    await withQueue(async (queue, dispatcher) => {
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(1);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        'PUBLISHED',
      );
    });
  });
  it('TC-QUE-004 fresh outbox lease is not stolen', async () => {
    const id = await immediate();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } });
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', lockedAt: new Date() },
    });
    await withQueue(async (queue, dispatcher) => {
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(0);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        'PROCESSING',
      );
    });
  });
  it.each([
    { schemaVersion: 2, publicationId: 'invalid' },
    { schemaVersion: 1 },
    { publicationId: 'invalid' },
  ])('TC-QUE-005 invalid payload %# is terminally rejected', async (payload) => {
    const id = await immediate();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } });
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { payload } });
    await withQueue(async (queue, dispatcher) => {
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(0);
      expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
        { status: 'FAILED', lastErrorCode: 'INVALID_OUTBOX_PAYLOAD' },
      );
    });
  });
  it('TC-QUE-006 duplicate generation concurrent and after success cannot duplicate charge or artifacts', async () => {
    const id = await immediate();
    await Promise.all([
      app.get(GenerationService).generate(id),
      app.get(GenerationService).generate(id),
    ]);
    await app.get(GenerationService).generate(id, true);
    expect(text).toHaveBeenCalledTimes(1);
    expect(await prisma.aIRequest.count({ where: { publicationId: id } })).toBe(1);
    expect(await prisma.postVersion.count({ where: { publicationId: id } })).toBe(1);
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 1 });
  });
  it('TC-QUE-010 published outbox with lost Redis job is reconciled from PostgreSQL', async () => {
    const id = await immediate();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } });
    await withQueue(async (queue, dispatcher) => {
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(1);
      await queue.obliterate({ force: true });
      const restarted = new OutboxDispatcherService(
        prisma,
        app.get<ConfigService<AppEnvironment, true>>(ConfigService),
        queue,
      );
      await restarted.dispatchPending();
      console.info(
        'ACCEPTANCE_EVIDENCE ' +
          JSON.stringify({
            caseId: 'TC-QUE-010',
            outboxStatus: (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }))
              .status,
            publicationStatus: (await prisma.publication.findUniqueOrThrow({ where: { id } }))
              .status,
            waiting: await queue.getWaitingCount(),
          }),
      );
      expect(await queue.getWaitingCount()).toBe(1);
    });
  });
  it('TC-QUE-014 generation and publication job IDs accepted by real BullMQ', async () => {
    await immediate();
    await withQueue(async (queue, dispatcher) => {
      await dispatcher.dispatchPending();
      expect(await queue.getWaitingCount()).toBe(1);
      // A dedicated no-worker queue receives publication payloads for ID validation.
      const publisher = new PublicationDispatcherService(
        prisma,
        app.get<ConfigService<AppEnvironment, true>>(ConfigService),
        queue,
      );
      await publisher.dispatchDue();
      expect(await queue.getWaitingCount()).toBe(2);
    });
  });
  it('TC-QUE-021 stale worker payload rereads durable state and cannot resurrect cancelled work', async () => {
    const id = await immediate();
    await call('POST', `/api/v1/publications/${id}/cancel`).expect(201);
    await app.get(GenerationService).generate(id, true);
    await app.get(PublishingService).publish(id);
    expect(text).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
      'CANCELLED',
    );
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
  });
  it.each(['TC-TMP-002', 'TC-TMP-003', 'TC-TMP-004'])(
    '%s image file is removed after every outcome',
    async (caseId) => {
      await enableImage();
      const paths: string[] = [];
      const create = app.get(ImageTempService).createFile.bind(app.get(ImageTempService));
      generateImage.mockImplementation(async () => {
        const path = await create(Uint8Array.of(1, 2, 3));
        paths.push(path);
        return { filePath: path };
      });
      if (caseId === 'TC-TMP-003')
        sendPhoto.mockRejectedValueOnce(
          new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 1),
        );
      const commit =
        caseId === 'TC-TMP-004'
          ? vi.spyOn(usage, 'commit').mockRejectedValueOnce(new Error('injected quota error'))
          : undefined;
      try {
        await app.get(PublishingService).publish(publicationA);
      } finally {
        commit?.mockRestore();
      }
      expect(paths).toHaveLength(1);
      for (const path of paths)
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      const p = await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } });
      if (caseId === 'TC-TMP-002')
        expect(p).toMatchObject({ status: 'PUBLISHED', publishedWithImage: true });
    },
  );
  it.each([
    ['publisher-partial-success', null],
    ['publisher-partial-terminal', 'TELEGRAM_FORBIDDEN'],
    ['publisher-partial-rate-limit', 'TELEGRAM_RATE_LIMIT'],
    ['publisher-partial-unknown', 'TELEGRAM_NETWORK_ERROR'],
  ])('%s durable publisher result %s', async (caseId, code) => {
    if (code)
      sendText.mockRejectedValueOnce(
        new TelegramPublicationError(
          code,
          code !== 'TELEGRAM_FORBIDDEN',
          code === 'TELEGRAM_NETWORK_ERROR',
          code === 'TELEGRAM_RATE_LIMIT' ? 17 : undefined,
        ),
      );
    const start = Date.now();
    await app.get(PublishingService).publish(publicationA);
    const p = await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } });
    if (!code) {
      expect(p).toMatchObject({
        status: 'PUBLISHED',
        telegramChatId: -100111n,
        telegramMessageId: 10n,
        publishedWithImage: false,
      });
      expect(p.publishedAt).not.toBeNull();
    } else if (code === 'TELEGRAM_FORBIDDEN')
      expect(p).toMatchObject({ status: 'FAILED', errorCode: code });
    else if (code === 'TELEGRAM_RATE_LIMIT') {
      expect(p.status).toBe('RETRY_WAIT');
      expect(p.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(start + 17000);
    } else {
      expect(p.status).toBe('DELIVERY_UNKNOWN');
      await app.get(PublishingService).publish(publicationA);
      expect(sendText).toHaveBeenCalledTimes(1);
    }
    expect(caseId).toBeTruthy();
  });

  const completion = (
    content: unknown = 'Final provider artifact',
    reason = 'stop',
    extra: Record<string, unknown> = {},
  ) => ({
    id: 'safe-provider-id',
    choices: [
      { message: { content, reasoning: 'DO_NOT_PERSIST_REASONING' }, finish_reason: reason },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    ...extra,
  });
  async function withTextUpstream(work: (mock: MockInstance<typeof fetch>) => Promise<void>) {
    const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
    config.set('GPTUNNEL_API_KEY', 'fixture-provider-key');
    const adapter = new GptunnelTextGenerationAdapter(config, new GptunnelClient(config));
    text.mockImplementation((input) => adapter.generate(input));
    const mock = vi.spyOn(globalThis, 'fetch');
    try {
      await work(mock);
    } finally {
      mock.mockRestore();
      config.set('GPTUNNEL_API_KEY', '');
    }
  }
  function jsonReply(value: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(value), { status, headers });
  }
  it('TC-TXT-003 real adapter uses GPTunnel chat protocol through generation service', async () => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion()));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      const [url, init] = mock.mock.calls[0]!;
      expect(url).toBe('https://gptunnel.ru/v1/chat/completions');
      expect(init?.headers).toMatchObject({ Authorization: 'fixture-provider-key' });
      const body = JSON.parse(init?.body as string) as { stream: boolean; messages: unknown[] };
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(2);
      expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe('READY');
    });
  });
  it('TC-TXT-004 topic guidance is included once without becoming stored final text', async () => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion()));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      const body = JSON.parse(mock.mock.calls[0]![1]!.body as string) as {
        messages: Array<{ content: string }>;
      };
      expect(
        body.messages
          .map((x) => x.content)
          .join('\n')
          .split('Test guidance'),
      ).toHaveLength(2);
      const version = await prisma.postVersion.findFirstOrThrow({ where: { publicationId: id } });
      expect(version.text).toBe('Final provider artifact');
    });
  });
  it.each([
    ['TC-TXT-007', 402, 'AI_PROVIDER_INSUFFICIENT_BALANCE'],
    ['TC-TXT-008', 401, 'AI_PROVIDER_UNAUTHORIZED'],
    ['TC-TXT-009', 403, 'AI_PROVIDER_FORBIDDEN'],
    ['TC-TXT-010', 404, 'AI_PROVIDER_HTTP_404'],
    ['TC-TXT-010', 410, 'AI_PROVIDER_HTTP_410'],
  ] as const)('%s upstream HTTP %s has terminal durable outcome', async (_caseId, status, code) => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply({ message: 'DO_NOT_EXPOSE_PRIVATE_PROVIDER_BODY' }, status));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      const p = await prisma.publication.findUniqueOrThrow({ where: { id } });
      expect(p).toMatchObject({ status: 'FAILED', errorCode: code });
      expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
      expect(JSON.stringify(p)).not.toContain('DO_NOT_EXPOSE');
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });
  it.each([408, 429, 500, 502, 503, 504])(
    'TC-TXT-011 transient HTTP %s retries same request and version exactly once',
    async (status) => {
      await withTextUpstream(async (mock) => {
        mock
          .mockResolvedValueOnce(jsonReply({}, status))
          .mockResolvedValueOnce(jsonReply(completion()));
        const id = await immediate();
        await expect(app.get(GenerationService).generate(id)).rejects.toMatchObject({
          retryable: true,
        });
        await app.get(GenerationService).generate(id, true);
        expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
          'READY',
        );
        expect(await prisma.postVersion.count({ where: { publicationId: id } })).toBe(1);
        expect(await prisma.aIRequest.count({ where: { publicationId: id } })).toBe(1);
        expect(await textCounter()).toMatchObject({ reserved: 0, committed: 1 });
      });
    },
  );
  it('TC-TXT-015 malformed upstream JSON safely fails and releases quota', async () => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(new Response('DO_NOT_EXPOSE_NOT_JSON'));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_PROVIDER_INVALID_RESPONSE',
      });
      expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
    });
  });
  it.each([{}, { choices: [] }, completion(null), completion(123), completion('')])(
    'TC-TXT-016 unusable content variant %# cannot be published',
    async (payload) => {
      await withTextUpstream(async (mock) => {
        mock.mockResolvedValue(jsonReply(payload));
        const id = await immediate();
        await app.get(GenerationService).generate(id);
        expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
          'FAILED',
        );
        expect(
          (await prisma.postVersion.findFirstOrThrow({ where: { publicationId: id } })).text,
        ).toBeNull();
        expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
        expect(sendText).not.toHaveBeenCalled();
      });
    },
  );
  it.each([
    ['TC-TXT-017', ' \n ', 'stop', 'AI_PROVIDER_EMPTY_RESPONSE'],
    ['TC-TXT-018', 'Truncated', 'length', 'AI_PROVIDER_TRUNCATED_RESPONSE'],
    ['TC-TXT-019', '', 'content_filter', 'AI_PROVIDER_CONTENT_REJECTED'],
  ])('%s rejected completion safely releases quota', async (_id, content, reason, code) => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion(content, reason)));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'FAILED',
        errorCode: code,
      });
      expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
    });
  });
  it('TC-TXT-020 reasoning fields never enter durable generation records', async () => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion()));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      const rows = await Promise.all([
        prisma.postVersion.findMany({ where: { publicationId: id } }),
        prisma.aIRequest.findMany({ where: { publicationId: id } }),
        prisma.publication.findMany({ where: { id } }),
      ]);
      expect(JSON.stringify(rows)).not.toContain('DO_NOT_PERSIST_REASONING');
      expect(
        (await prisma.postVersion.findFirstOrThrow({ where: { publicationId: id } })).text,
      ).toBe('Final provider artifact');
    });
  });
  it.each([
    undefined,
    { prompt_tokens: 5, completion_tokens: 7 },
    { prompt_tokens: -1, completion_tokens: 1.5 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: '7' },
  ])('TC-TXT-021 usage metadata variant %# is safe integers or null', async (providerUsage) => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion('Final', 'stop', { usage: providerUsage })));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      const row = await prisma.aIRequest.findFirstOrThrow({ where: { publicationId: id } });
      expect(row.inputUnits).toBe(providerUsage?.prompt_tokens === 5 ? 5 : null);
      expect(row.outputUnits).toBe(providerUsage?.completion_tokens === 7 ? 7 : null);
    });
  });
  for (const image of [false, true])
    it.each(image ? [1024, 1025] : [4096, 4097])(
      (image ? 'TC-TXT-024' : 'TC-TXT-023') +
        ' final length %s is checked before image and Telegram',
      async (length) => {
        await prisma.post.update({ where: { id: postA }, data: { generateImage: image } });
        await withTextUpstream(async (mock) => {
          mock.mockResolvedValue(jsonReply(completion('x'.repeat(length))));
          const id = await immediate();
          await app.get(GenerationService).generate(id);
          expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
            length === (image ? 1024 : 4096) ? 'READY' : 'FAILED',
          );
          expect(generateImage).not.toHaveBeenCalled();
          expect(sendPhoto).not.toHaveBeenCalled();
        });
      },
    );
  it.each([
    '😀'.repeat(2048),
    '😀'.repeat(2048) + 'a',
    'e\u0301'.repeat(2048),
    'e\u0301'.repeat(2048) + 'a',
  ])('TC-TXT-025 Unicode limit variant %# uses intact UTF-16 length', async (content) => {
    await withTextUpstream(async (mock) => {
      mock.mockResolvedValue(jsonReply(completion(content)));
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
        content.length <= 4096 ? 'READY' : 'FAILED',
      );
      if (content.length <= 4096)
        expect(
          (await prisma.postVersion.findFirstOrThrow({ where: { publicationId: id } })).text,
        ).toBe(content);
    });
  });
  it('TC-ENV-012 missing GPTunnel credentials leave health available and generation safely fails', async () => {
    await withTextUpstream(async (mock) => {
      app.get(ConfigService).set('GPTUNNEL_API_KEY', '');
      process.env.GPTUNNEL_API_KEY = '';
      const id = await immediate();
      await app.get(GenerationService).generate(id);
      await call('GET', '/api/v1/health/live').expect(200);
      await call('GET', '/api/v1/health/ready').expect(200);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_PROVIDER_NOT_CONFIGURED',
      });
      expect(mock).not.toHaveBeenCalled();
    });
  });
  it('TC-ENV-013 retired OPEN_API_KEY cannot authorize provider call', async () => {
    await withTextUpstream(async (mock) => {
      app.get(ConfigService).set('GPTUNNEL_API_KEY', '');
      process.env.GPTUNNEL_API_KEY = '';
      process.env.OPEN_API_KEY = 'retired-fixture-key';
      try {
        const id = await immediate();
        await app.get(GenerationService).generate(id);
        expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'FAILED',
          errorCode: 'AI_PROVIDER_NOT_CONFIGURED',
        });
        expect(mock).not.toHaveBeenCalled();
      } finally {
        delete process.env.OPEN_API_KEY;
      }
    });
  });

  const protectedReads = () => [
    '/api/v1/me',
    '/api/v1/channels',
    `/api/v1/channels/${channelA}`,
    '/api/v1/topics',
    `/api/v1/topics/${topicA}`,
    '/api/v1/posts',
    `/api/v1/posts/${postA}`,
    `/api/v1/posts/${postA}/versions`,
    '/api/v1/subscription',
    '/api/v1/usage',
    '/api/v1/moderation',
    '/api/v1/schedules',
    `/api/v1/schedules/${scheduleB}`,
    '/api/v1/publications',
    `/api/v1/publications/${publicationA}`,
  ];
  it('TC-HTTP-001 all protected read and command routes require authentication', async () => {
    const before = await prisma.post.count();
    for (const path of protectedReads()) await request(app.getHttpServer()).get(path).expect(401);
    for (const path of [
      '/api/v1/channels',
      '/api/v1/topics',
      '/api/v1/posts',
      '/api/v1/schedules',
      `/api/v1/posts/${postA}/publications`,
      `/api/v1/moderation/${moderationB}/approve`,
      `/api/v1/moderation/${moderationB}/reject`,
      `/api/v1/moderation/${moderationB}/revision`,
      `/api/v1/publications/${publicationA}/retry`,
      `/api/v1/publications/${publicationA}/cancel`,
      `/api/v1/schedules/${scheduleB}/pause`,
      `/api/v1/schedules/${scheduleB}/resume`,
    ])
      await request(app.getHttpServer()).post(path).send({}).expect(401);
    for (const path of [
      `/api/v1/channels/${channelA}`,
      `/api/v1/topics/${topicA}`,
      `/api/v1/posts/${postA}`,
      `/api/v1/schedules/${scheduleB}`,
    ]) {
      await request(app.getHttpServer()).patch(path).send({}).expect(401);
      await request(app.getHttpServer()).delete(path).expect(401);
    }
    expect(await prisma.post.count()).toBe(before);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
  });
  it('TC-HTTP-012 empty PATCH is explicit refusal with no field resets', async () => {
    for (const resource of ['channels', 'topics', 'posts'] as const) {
      const id = resource === 'channels' ? channelA : resource === 'topics' ? topicA : postA;
      await call('PATCH', `/api/v1/${resource}/${id}`, {}).expect(400);
    }
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postA } })).version).toBe(1);
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: topicA } })).version).toBe(1);
  });
  it.each(['ordinary', '12345678-1234', '00000000-0000-0000-0000-000000000000', randomUUID()])(
    'TC-HTTP-013 path UUID variant %s never leaks internal 500',
    async (id) => {
      for (const resource of ['channels', 'topics', 'posts', 'schedules', 'publications']) {
        const r = await call('GET', `/api/v1/${resource}/${id}`);
        expect([400, 404]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(/Prisma|SELECT|stack/);
      }
    },
  );
  it('TC-HTTP-014 runtime OpenAPI and Swagger are available and contain current routes', async () => {
    const r = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const document = r.body as { info: { title: string }; paths: Record<string, unknown> };
    expect(document.info.title).toBe('Autobot Backend API');
    for (const path of [
      '/api/v1/posts',
      '/api/v1/schedules',
      '/api/v1/publications',
      '/api/v1/moderation',
    ])
      expect(document.paths).toHaveProperty(path);
    await request(app.getHttpServer()).get('/api/docs/').expect(200);
  });
  it('TC-HTTP-016 successful and denied auth responses cannot be cached', async () => {
    for (const path of [
      '/api/v1/auth/session',
      '/api/v1/auth/csrf',
      '/api/v1/auth/telegram/callback',
    ]) {
      const r = await request(app.getHttpServer()).get(path);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const r = await call('POST', '/api/v1/auth/logout');
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('http-partial security headers are present on local HTTP successes and errors', async () => {
    for (const path of ['/api/v1/health/live', '/api/v1/missing']) {
      const r = await request(app.getHttpServer()).get(path);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['content-security-policy']).toBeTruthy();
    }
  });
  it.each([undefined, 'safe-request-id-123', 'x'.repeat(129)])(
    'http-partial request-ID variant %# is bounded and safe',
    async (id) => {
      const req = request(app.getHttpServer()).get('/api/v1/health/live');
      if (id) req.set('X-Request-Id', id);
      const r = await req.expect(200);
      expect(r.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
      if (id === 'safe-request-id-123') expect(r.headers['x-request-id']).toBe(id);
    },
  );
  it('TC-OBS-001 liveness returns exact safe schema and configured revision', async () => {
    const r = await call('GET', '/api/v1/health/live').expect(200);
    expect(r.body).toMatchObject({
      status: 'ok',
      service: 'autobot-api',
    });
    expect(typeof (r.body as { version: unknown }).version).toBe('string');
    expect(typeof (r.body as { timestamp: unknown }).timestamp).toBe('string');
    expect(Object.keys(r.body as Record<string, unknown>).sort()).toEqual([
      'service',
      'status',
      'timestamp',
      'version',
    ]);
  });
  it('TC-OBS-002 readiness checks real PostgreSQL and Redis', async () => {
    const r = await call('GET', '/api/v1/health/ready').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', dependencies: { postgres: 'up', redis: 'up' } });
  });
  it('TC-SEC-010 disabled metrics respond 404 even with valid principal', async () => {
    const config = app.get(ConfigService);
    config.set('METRICS_ENABLED', false);
    await call('GET', '/api/v1/internal/metrics').expect(404);
  });
  it.each([undefined, 'incorrect', 'x'.repeat(1000)])(
    'TC-SEC-009 metrics token variant %# cannot be replaced by bot auth',
    async (token) => {
      const config = app.get(ConfigService);
      config.set('METRICS_ENABLED', true);
      config.set('METRICS_AUTH_TOKEN', 'm'.repeat(32));
      try {
        const req = call('GET', '/api/v1/internal/metrics');
        if (token) req.set('X-Metrics-Token', token);
        await req.expect(401);
      } finally {
        config.set('METRICS_ENABLED', false);
      }
    },
  );
  it('TC-OBS-005 Prometheus format and escaped labels with authorized endpoint', async () => {
    const config = app.get(ConfigService);
    config.set('METRICS_ENABLED', true);
    config.set('METRICS_AUTH_TOKEN', 'm'.repeat(32));
    try {
      const metrics = app.get(MetricsService);
      metrics.increment('acceptance_counter_total', { value: 'a"b\\c\nd' });
      metrics.observe('acceptance_duration_seconds', 0.5);
      const r = await call('GET', '/api/v1/internal/metrics')
        .set('X-Metrics-Token', 'm'.repeat(32))
        .expect(200);
      expect(r.headers['content-type']).toContain('text/plain');
      expect(r.text).toContain('acceptance_counter_total{value="a\\"b\\\\c\\nd"} 1');
      expect(r.text).toContain('acceptance_duration_seconds_count 1');
      expect(r.text).toContain('acceptance_duration_seconds_sum 0.5');
    } finally {
      config.set('METRICS_ENABLED', false);
    }
  });
  it('TC-SEC-016 arbitrary paths and secrets cannot create unbounded metric labels', async () => {
    const marker = `private-${randomUUID()}`;
    await call('GET', '/api/v1/' + marker).expect(404);
    const output = app.get(MetricsService).renderPrometheus();
    expect(output).not.toContain(marker);
    expect(output).not.toContain(secret);
  });
  it.each(['__proto__', 'constructor', 'prototype'])(
    'TC-SEC-005 JSON %s cannot pollute prototypes or escalate plan',
    async (field) => {
      const payload = JSON.parse(
        '{"name":"test","promptTemplate":"test","' + field + '":{"isAdmin":true}}',
      ) as unknown;
      const r = await call('POST', '/api/v1/topics', payload);
      expect([201, 400]).toContain(r.status);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect((await app.get(EntitlementService).resolve(a)).planCode).toBe('pro');
    },
  );
  it('TC-SEC-002 SQL markers remain data across fields query and cursor', async () => {
    const marker = '\'; DROP TABLE "User"; --';
    const r = await call('POST', '/api/v1/topics', { name: marker, promptTemplate: marker }).expect(
      201,
    );
    expect(responseBody(r).data.name).toBe(marker);
    await call('GET', `/api/v1/posts?channelId=${encodeURIComponent(marker)}`).expect(400);
    await call('GET', `/api/v1/topics?cursor=${encodeURIComponent(marker)}`).expect(400);
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.topic.count()).toBe(3);
  });

  it.each([
    ['TC-BND-031', 0],
    ['TC-BND-032', 1],
    ['TC-BND-033', 3999],
    ['TC-BND-034', 4000],
    ['TC-BND-035', 4001],
  ] as const)('%s moderation feedback length %s', async (_caseId, length) => {
    const { id, mod } = await review();
    const ledger = await prisma.usageLedgerEntry.count();
    const r = await call('POST', `/api/v1/moderation/${mod.id}/revision`, {
      feedback: 'a'.repeat(length),
    });
    expect(r.status).toBe(length === 0 || length === 4001 ? 400 : 202);
    if (r.status === 400) {
      expect(await prisma.usageLedgerEntry.count()).toBe(ledger);
      expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe(
        'AWAITING_MODERATION',
      );
    }
  });
  it.each([
    ['TC-BND-036', '0', false],
    ['TC-BND-037', '-1000000000000', true],
    ['TC-BND-038', '1000000000000', true],
    ['TC-BND-039', '01', false],
    ['TC-BND-040', '1.5', false],
    ['TC-BND-041', '1e3', false],
    ['TC-BND-042', '@channel', false],
    ['TC-BND-043', 'null', false],
    ['TC-BND-044', 'true', false],
    ['TC-BND-045', '[]', false],
    ['TC-BND-043', null, false],
    ['TC-BND-044', true, false],
    ['TC-BND-045', [], false],
  ] as const)(
    '%s channel ID variant %# has no implicit conversion',
    async (_caseId, telegramChatId, valid) => {
      const r = await call('POST', '/api/v1/channels', { telegramChatId });
      expect(r.status).toBe(valid ? 201 : 400);
      expect(validateChannel.mock.calls.length).toBe(valid ? 1 : 0);
      expect(await prisma.channel.count({ where: { userId: a } })).toBe(valid ? 2 : 1);
    },
  );
  it('TC-CHN-011 relink archived channel preserves ID and history', async () => {
    await call('DELETE', `/api/v1/channels/${channelA}`).expect(204);
    const r = await call('POST', '/api/v1/channels', { telegramChatId: '-100111' }).expect(201);
    expect(responseBody(r).data.id).toBe(channelA);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).status).toBe(
      'ACTIVE',
    );
    expect(await prisma.postVersion.count({ where: { postId: postA } })).toBe(1);
  });
  it('TC-CHN-012 relink cannot bypass exhausted free capacity', async () => {
    await call('DELETE', `/api/v1/channels/${channelA}`).expect(204);
    await prisma.channel.create({
      data: { userId: a, telegramChatId: -100555n, title: 'replacement', status: 'ACTIVE' },
    });
    await freeA();
    await call('POST', '/api/v1/channels', { telegramChatId: '-100111' }).expect(403);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).status).toBe(
      'ARCHIVED',
    );
  });
  it('TC-CHN-013 channel lists filter every status and remain owned', async () => {
    for (const status of ['ACTIVE', 'ARCHIVED', 'INVALID'] as const) {
      await prisma.channel.update({ where: { id: channelA }, data: { status } });
      const r = await call('GET', `/api/v1/channels?status=${status}`).expect(200);
      const rows = (r.body as { data: Array<{ id: string; status: string }> }).data;
      expect(rows).toEqual([expect.objectContaining({ id: channelA, status })]);
    }
    await call('GET', '/api/v1/channels?status=UNKNOWN').expect(400);
  });
  it('TC-CHN-017 archived channel cannot initiate paid publication', async () => {
    await call('DELETE', `/api/v1/channels/${channelA}`).expect(204);
    await call('POST', `/api/v1/posts/${postA}/publications`).expect(422);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.usageLedgerEntry.count()).toBe(0);
    expect(text).not.toHaveBeenCalled();
  });
  it('TC-CHN-019 restored permissions reactivate invalid channel without duplicates', async () => {
    await prisma.channel.update({ where: { id: channelA }, data: { status: 'INVALID' } });
    await call('POST', `/api/v1/channels/${channelA}/verify`).expect(201);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).status).toBe(
      'ACTIVE',
    );
    expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
  });
  it('TC-CHN-021 verify refreshes metadata while preserving numeric linkage', async () => {
    validateChannel.mockResolvedValueOnce({
      telegramChatId: -100111n,
      title: 'Changed title',
      username: 'new_name',
      botPermissions: { status: 'administrator', canPostMessages: true },
    });
    await call('POST', `/api/v1/channels/${channelA}/verify`).expect(201);
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).toMatchObject({
      title: 'Changed title',
      username: 'new_name',
      telegramChatId: -100111n,
    });
  });
  it('TC-PUB-004 missing selected final text rejects before Telegram', async () => {
    await prisma.postVersion.updateMany({
      where: { publicationId: publicationA },
      data: { text: null },
    });
    await app.get(PublishingService).publish(publicationA);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'PUBLICATION_TEXT_NOT_AVAILABLE' });
    expect(sendText).not.toHaveBeenCalled();
  });
  it('TC-PUB-003 approved selected version is sent even when newer unselected versions exist', async () => {
    const original = await prisma.postVersion.findFirstOrThrow({
      where: { publicationId: publicationA },
    });
    await prisma.postVersion.create({
      data: {
        postId: postA,
        publicationId: publicationA,
        sequence: 2,
        status: 'GENERATED',
        text: 'Unselected newer text',
      },
    });
    await app.get(PublishingService).publish(publicationA);
    expect(sendText.mock.calls[0]?.[1]).toBe(original.text);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
  it('TC-PUB-011 Telegram rate-limit retries only when nextAttemptAt is due', async () => {
    sendText.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMIT', true, false, 17),
    );
    const start = Date.now();
    await app.get(PublishingService).publish(publicationA);
    const p = await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } });
    expect(p.status).toBe('RETRY_WAIT');
    expect(p.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(start + 17000);
    await app.get(PublishingService).publish(publicationA);
    expect(sendText).toHaveBeenCalledTimes(1);
    await prisma.publication.update({
      where: { id: publicationA },
      data: { nextAttemptAt: new Date(0) },
    });
    await app.get(PublishingService).publish(publicationA);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('PUBLISHED');
  });
  it('TC-PUB-012 transient Telegram failure has bounded retry on one occurrence', async () => {
    sendText.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_API_UNAVAILABLE', true, false),
    );
    await app.get(PublishingService).publish(publicationA);
    await prisma.publication.update({
      where: { id: publicationA },
      data: { nextAttemptAt: new Date(0) },
    });
    await app.get(PublishingService).publish(publicationA);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('PUBLISHED');
    expect(await prisma.publication.count({ where: { postId: postA } })).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(2);
  });
  it('TC-PUB-013 ambiguous delivery cannot automatically resend', async () => {
    sendText.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_DELIVERY_UNKNOWN', false, true),
    );
    await app.get(PublishingService).publish(publicationA);
    await app.get(PublishingService).publish(publicationA);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('DELIVERY_UNKNOWN');
    expect(sendText).toHaveBeenCalledTimes(1);
  });
  it('TC-PUB-021 manual retry retains same occurrence and resets attempts safely for text', async () => {
    app.get(ConfigService).set('PUBLICATION_MAX_ATTEMPTS', 1);
    sendText.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_API_UNAVAILABLE', true, false),
    );
    await app.get(PublishingService).publish(publicationA);
    await call('POST', `/api/v1/publications/${publicationA}/retry`).expect(202);
    await app.get(PublishingService).publish(publicationA);
    expect(
      (await prisma.publication.findUniqueOrThrow({ where: { id: publicationA } })).status,
    ).toBe('PUBLISHED');
    expect(await prisma.publication.count({ where: { postId: postA } })).toBe(1);
  });
  it('TC-PUB-025 repeated cancel with same and new key cannot repeat usage release', async () => {
    const id = await immediate();
    const key = randomUUID();
    await call('POST', `/api/v1/publications/${id}/cancel`).set('Idempotency-Key', key).expect(201);
    const count = await prisma.usageLedgerEntry.count();
    await call('POST', `/api/v1/publications/${id}/cancel`).set('Idempotency-Key', key).expect(201);
    await call('POST', `/api/v1/publications/${id}/cancel`).expect(201);
    expect(await prisma.usageLedgerEntry.count()).toBe(count);
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 0 });
  });
  it('TC-MOD-018 terminal revision generation releases text quota and records coherent failure', async () => {
    const { id, mod } = await review();
    await call('POST', `/api/v1/moderation/${mod.id}/revision`, { feedback: 'Change' }).expect(202);
    text.mockRejectedValueOnce(new TextGenerationProviderError('AI_PROVIDER_FORBIDDEN', false));
    await app.get(GenerationService).generate(id);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
    expect(await textCounter()).toMatchObject({ reserved: 0, committed: 1 });
    expect(
      (await prisma.postVersion.findUniqueOrThrow({ where: { id: mod.versionId } })).text,
    ).toBe('Test final artifact');
  });

  async function withChannelUpstream(
    options: {
      type?: string;
      member?: Record<string, unknown>;
      status?: number;
      timeout?: boolean;
      username?: string | undefined;
    },
    work: () => Promise<void>,
  ) {
    const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
    config.set('TELEGRAM_BOT_TOKEN', 'fixture-bot-token');
    const adapter = new TelegramBotApiChannelAdapter(config);
    validateChannel.mockImplementation((id) => adapter.validate(id));
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource) => {
      await Promise.resolve();
      if (options.timeout) throw new Error('controlled network timeout');
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url;
      if (url.endsWith('/getChat'))
        return jsonReply(
          {
            ok: !options.status,
            result: {
              id: -100333,
              type: options.type ?? 'channel',
              title: 'Controlled channel',
              username: options.username,
            },
          },
          options.status ?? 200,
        );
      if (url.endsWith('/getMe')) return jsonReply({ ok: true, result: { id: 777 } });
      if (url.endsWith('/getChatMember'))
        return jsonReply({
          ok: true,
          result: options.member ?? { status: 'administrator', can_post_messages: true },
        });
      throw new Error('Unexpected controlled URL');
    });
    try {
      await work();
    } finally {
      upstream.mockRestore();
      config.set('TELEGRAM_BOT_TOKEN', '');
      validateChannel.mockImplementation((telegramChatId) =>
        Promise.resolve({
          telegramChatId,
          title: 'Acceptance channel',
          username: null,
          botPermissions: { status: 'administrator', canPostMessages: true },
        }),
      );
    }
  }
  it.each([
    ['TC-CHN-001', 'public_name'],
    ['TC-CHN-002', undefined],
  ])('%s real channel adapter validates numeric identity and metadata', async (_id, username) => {
    await withChannelUpstream({ username }, async () => {
      const r = await call('POST', '/api/v1/channels', { telegramChatId: '-100333' }).expect(201);
      const p = await prisma.channel.findUniqueOrThrow({ where: { id: responseBody(r).data.id } });
      expect(p).toMatchObject({
        userId: a,
        title: 'Controlled channel',
        username: username ?? null,
        status: 'ACTIVE',
      });
    });
  });
  it('TC-CHN-004 non-member bot cannot link channel', async () => {
    await withChannelUpstream({ member: { status: 'left' } }, async () => {
      await call('POST', '/api/v1/channels', { telegramChatId: '-100333' }).expect(422);
      expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
    });
  });
  it.each(['create', 'verify'])('TC-CHN-005 no publish permission blocks %s', async (variant) => {
    await withChannelUpstream(
      { member: { status: 'administrator', can_post_messages: false } },
      async () => {
        await call(
          'POST',
          variant === 'create' ? '/api/v1/channels' : `/api/v1/channels/${channelA}/verify`,
          variant === 'create' ? { telegramChatId: '-100333' } : undefined,
        ).expect(422);
        if (variant === 'verify')
          expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).status).toBe(
            'INVALID',
          );
        expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
      },
    );
  });
  it.each(['group', 'supergroup'])('TC-CHN-006 rejects Telegram %s as channel', async (type) => {
    await withChannelUpstream({ type }, async () => {
      await call('POST', '/api/v1/channels', { telegramChatId: '-100333' }).expect(422);
      expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
    });
  });
  it('TC-CHN-007 nonexistent Telegram chat has domain refusal without partial record', async () => {
    await withChannelUpstream({ status: 400 }, async () => {
      await call('POST', '/api/v1/channels', { telegramChatId: '-100333' }).expect(422);
      expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
    });
  });
  it('TC-CHN-018 revoked permissions invalidate linked channel and block new paid work', async () => {
    await withChannelUpstream(
      { member: { status: 'administrator', can_post_messages: false } },
      async () => {
        await call('POST', `/api/v1/channels/${channelA}/verify`).expect(422);
        expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelA } })).status).toBe(
          'INVALID',
        );
        await call('POST', `/api/v1/posts/${postA}/publications`).expect(422);
        expect(await prisma.usageLedgerEntry.count()).toBe(0);
      },
    );
  });
  it('TC-CHN-020 network timeout at link preserves database', async () => {
    await withChannelUpstream({ timeout: true }, async () => {
      await call('POST', '/api/v1/channels', { telegramChatId: '-100333' }).expect(503);
      expect(await prisma.channel.count({ where: { userId: a } })).toBe(1);
    });
  });
  async function recurring(rule: string, anchor: Date) {
    await prisma.postSchedule.update({ where: { id: scheduleB }, data: { status: 'PAUSED' } });
    return prisma.postSchedule.create({
      data: {
        postId: postA,
        kind: 'RECURRING',
        timezone: 'UTC',
        runAt: anchor,
        nextRunAt: anchor,
        rrule: rule,
        misfirePolicy: 'LATEST_ONLY',
        misfireGraceSeconds: 21600,
      },
    });
  }
  it.each([1, 3])(
    'TC-RRU-010 COUNT %s creates exactly specified occurrences then completes',
    async (count) => {
      const anchor = new Date();
      const s = await recurring(`FREQ=DAILY;COUNT=${count}`, anchor);
      for (let i = 0; i < count + 2; i++)
        await app.get(SchedulesService).materializeDue(new Date(anchor.getTime() + i * 86400000));
      expect(await prisma.publication.count({ where: { scheduleId: s.id } })).toBe(count);
      expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({
        status: 'COMPLETED',
        nextRunAt: null,
      });
      expect(await prisma.outboxEvent.count()).toBe(count);
    },
  );
  it.each(['date', 'datetime'])(
    'TC-RRU-011 UNTIL %s includes boundary and nothing beyond',
    async (variant) => {
      const anchor = new Date('2030-01-01T10:00:00Z');
      const s = await recurring(
        `FREQ=DAILY;UNTIL=${variant === 'date' ? '20300102' : '2030-01-02T10:00:00Z'}`,
        anchor,
      );
      for (let i = 0; i < 4; i++)
        await app.get(SchedulesService).materializeDue(new Date(anchor.getTime() + i * 86400000));
      const rows = await prisma.publication.findMany({
        where: { scheduleId: s.id },
        orderBy: { scheduledFor: 'asc' },
      });
      expect(rows.map((x) => x.scheduledFor.toISOString())).toEqual([
        '2030-01-01T10:00:00.000Z',
        '2030-01-02T10:00:00.000Z',
      ]);
      expect((await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'COMPLETED',
      );
    },
  );
  it('TC-RRU-021 LATEST_ONLY bounded reconciliation catches latest missed date', async () => {
    const now = new Date('2030-01-11T12:00:00Z');
    const s = await recurring('FREQ=DAILY', new Date('2030-01-01T10:00:00Z'));
    for (let cycle = 0; cycle < 15; cycle++) await app.get(SchedulesService).materializeDue(now);
    const rows = await prisma.publication.findMany({
      where: { scheduleId: s.id, status: 'PENDING' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheduledFor.toISOString()).toBe('2030-01-11T10:00:00.000Z');
    expect(
      (await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id } })).nextRunAt!.getTime(),
    ).toBeGreaterThan(now.getTime());
  });
  it('TC-RRU-022 long outage bounded reconciliation advances nextRunAt with no stale paid work', async () => {
    const now = new Date('2030-01-11T20:00:00Z');
    const s = await recurring('FREQ=DAILY', new Date('2030-01-01T10:00:00Z'));
    for (let cycle = 0; cycle < 15; cycle++) await app.get(SchedulesService).materializeDue(now);
    expect(await prisma.publication.count({ where: { scheduleId: s.id, status: 'PENDING' } })).toBe(
      0,
    );
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(
      (await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id } })).nextRunAt!.getTime(),
    ).toBeGreaterThan(now.getTime());
  });
});
