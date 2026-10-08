import { createHmac, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import {
  TelegramChannelAdapter,
  type ValidatedTelegramChannel,
} from '../src/channels/telegram-channel.adapter.js';
import { configureApplication } from '../src/bootstrap.js';
import { ApiHttpException } from '../src/common/http/api-http.exception.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { INITIAL_PLANS } from '../src/subscriptions/entitlement.types.js';
import { PlanProvisioningService } from '../src/subscriptions/plan-provisioning.service.js';
import { UsageService } from '../src/subscriptions/usage.service.js';
import { IdentityService } from '../src/users/identity.service.js';
import { cleanTestDatabase } from './support/test-database.js';

const BOT_SECRET = 'test-secret-32-bytes-long-1234567890';

class FakeTelegramChannelAdapter extends TelegramChannelAdapter {
  calls = 0;
  deniedChatIds = new Set<string>();

  validate(telegramChatId: bigint): Promise<ValidatedTelegramChannel> {
    this.calls += 1;
    if (this.deniedChatIds.has(telegramChatId.toString())) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TELEGRAM_BOT_CANNOT_POST',
        'The bot cannot post to the channel.',
      );
    }
    if (telegramChatId === -100404n) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TELEGRAM_CHANNEL_UNAVAILABLE',
        'The channel is unavailable to the bot.',
      );
    }
    if (telegramChatId === -100503n) {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TELEGRAM_API_UNAVAILABLE',
        'Telegram is temporarily unavailable.',
      );
    }
    return Promise.resolve({
      telegramChatId,
      title: `Channel ${telegramChatId.toString()}`,
      username: `channel_${telegramChatId.toString().replace('-', '')}`,
      botPermissions: { status: 'administrator', canPostMessages: true },
    });
  }
}

function signedHeaders(input: {
  telegramUserId: string;
  method: string;
  path: string;
  body?: string;
}): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = canonicalBotRequest({
    method: input.method,
    originalUrl: input.path,
    body: Buffer.from(input.body ?? ''),
    timestamp,
    nonce,
    telegramUserId: input.telegramUserId,
  });
  return {
    'X-Autobot-Service': 'autobot-bot',
    'X-Autobot-Key-Id': 'test-key',
    'X-Autobot-Timestamp': timestamp,
    'X-Autobot-Nonce': nonce,
    'X-Autobot-Signature': `v1=${createHmac('sha256', BOT_SECRET).update(canonical).digest('hex')}`,
    'X-Telegram-User-Id': input.telegramUserId,
  };
}

describe('core domain and entitlements', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let identities: IdentityService;
  let plans: PlanProvisioningService;
  let usage: UsageService;
  let telegram: FakeTelegramChannelAdapter;

  beforeAll(async () => {
    telegram = new FakeTelegramChannelAdapter();
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TelegramChannelAdapter)
      .useValue(telegram)
      .compile();
    app = moduleReference.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApplication(app, { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);
    identities = app.get(IdentityService);
    plans = app.get(PlanProvisioningService);
    usage = app.get(UsageService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    await plans.provision();
    telegram.calls = 0;
    telegram.deniedChatIds.clear();
  });

  afterAll(async () => app.close());

  async function user(telegramUserId: string) {
    return identities.resolveBotUser({ telegramUserId });
  }

  function postAs(
    telegramUserId: string,
    path: string,
    payload: unknown,
    key: string = randomUUID(),
  ) {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post(path)
      .set(signedHeaders({ telegramUserId, method: 'POST', path, body }))
      .set('Idempotency-Key', key)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('links a channel idempotently, enforces ownership and the default plan limit', async () => {
    await user('1001');
    await user('1002');
    const key = 'channel-create-0000000001';
    const created = await postAs(
      '1001',
      '/api/v1/channels',
      { telegramChatId: '-100101' },
      key,
    ).expect(201);
    const replay = await postAs(
      '1001',
      '/api/v1/channels',
      { telegramChatId: '-100101' },
      key,
    ).expect(201);
    expect(replay.body).toEqual(created.body);
    expect(telegram.calls).toBe(1);

    const channel = (created.body as { data: { id: string; version: number } }).data;
    const channelId = channel.id;
    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}`)
      .set(
        signedHeaders({
          telegramUserId: '1002',
          method: 'GET',
          path: `/api/v1/channels/${channelId}`,
        }),
      )
      .expect(404);

    const channelPath = `/api/v1/channels/${channelId}`;
    await request(app.getHttpServer())
      .delete(channelPath)
      .set(signedHeaders({ telegramUserId: '1001', method: 'DELETE', path: channelPath }))
      .set('If-Match', `"${channel.version}"`)
      .expect(204);
    const relinked = await postAs(
      '1001',
      '/api/v1/channels',
      { telegramChatId: '-100101' },
      'channel-relink-0000000001',
    ).expect(201);
    expect((relinked.body as { data: { id: string } }).data.id).toBe(channelId);

    const limited = await postAs('1001', '/api/v1/channels', {
      telegramChatId: '-100102',
    }).expect(403);
    expect((limited.body as { error: { code: string } }).error.code).toBe('CHANNEL_LIMIT_REACHED');
  });

  it('prevents concurrent channel creates from exceeding a plan limit', async () => {
    await user('2001');
    const responses = await Promise.all([
      postAs('2001', '/api/v1/channels', { telegramChatId: '-100201' }),
      postAs('2001', '/api/v1/channels', { telegramChatId: '-100202' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    expect(await prisma.channel.count()).toBe(1);
  });

  it('returns one result for concurrent retries with the same idempotency key', async () => {
    await user('2101');
    const key = 'concurrent-channel-00000001';
    const responses = await Promise.all([
      postAs('2101', '/api/v1/channels', { telegramChatId: '-100211' }, key),
      postAs('2101', '/api/v1/channels', { telegramChatId: '-100211' }, key),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(
      new Set(responses.map((response) => (response.body as { data: { id: string } }).data.id))
        .size,
    ).toBe(1);
    expect(await prisma.channel.count()).toBe(1);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
  });

  it('surfaces Telegram domain and availability failures without persisting channels', async () => {
    await user('3001');
    const missing = await postAs('3001', '/api/v1/channels', {
      telegramChatId: '-100404',
    }).expect(422);
    expect((missing.body as { error: { code: string } }).error.code).toBe(
      'TELEGRAM_CHANNEL_UNAVAILABLE',
    );
    const unavailable = await postAs('3001', '/api/v1/channels', {
      telegramChatId: '-100503',
    }).expect(503);
    expect((unavailable.body as { error: { code: string } }).error.code).toBe(
      'TELEGRAM_API_UNAVAILABLE',
    );
    expect(await prisma.channel.count()).toBe(0);
  });

  it('marks an existing channel invalid when Telegram revokes posting permission', async () => {
    await user('3101');
    const created = await postAs('3101', '/api/v1/channels', {
      telegramChatId: '-100311',
    }).expect(201);
    const channelId = (created.body as { data: { id: string } }).data.id;
    telegram.deniedChatIds.add('-100311');
    const path = `/api/v1/channels/${channelId}/verify`;
    const failed = await postAs('3101', path, {}).expect(422);
    expect((failed.body as { error: { code: string } }).error.code).toBe(
      'TELEGRAM_BOT_CANNOT_POST',
    );
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).toMatchObject({
      status: 'INVALID',
      version: 2,
    });
  });

  it('manages topics with version checks, idempotency, archive and limits', async () => {
    await user('4001');
    const first = await postAs(
      '4001',
      '/api/v1/topics',
      { name: 'News', description: null, promptTemplate: 'Write news' },
      'topic-create-000000000001',
    ).expect(201);
    const topic = (first.body as { data: { id: string; version: number } }).data;
    const path = `/api/v1/topics/${topic.id}`;
    const body = JSON.stringify({ description: 'Updated' });
    const updated = await request(app.getHttpServer())
      .patch(path)
      .set(signedHeaders({ telegramUserId: '4001', method: 'PATCH', path, body }))
      .set('If-Match', `"${topic.version}"`)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    expect((updated.body as { data: { version: number } }).data.version).toBe(2);

    await request(app.getHttpServer())
      .patch(path)
      .set(signedHeaders({ telegramUserId: '4001', method: 'PATCH', path, body }))
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(409);

    await request(app.getHttpServer())
      .delete(path)
      .set(signedHeaders({ telegramUserId: '4001', method: 'DELETE', path }))
      .set('If-Match', '"2"')
      .expect(204);
    const reactivated = await postAs(
      '4001',
      '/api/v1/topics',
      { name: 'News', description: 'Restored', promptTemplate: 'Write restored news' },
      'topic-relink-000000000001',
    ).expect(201);
    expect((reactivated.body as { data: { id: string } }).data.id).toBe(topic.id);

    await postAs('4001', '/api/v1/topics', { name: 'Two', promptTemplate: 'Two' }).expect(201);
    await postAs('4001', '/api/v1/topics', { name: 'Three', promptTemplate: 'Three' }).expect(201);
    const limited = await postAs('4001', '/api/v1/topics', {
      name: 'Four',
      promptTemplate: 'Four',
    }).expect(403);
    expect((limited.body as { error: { code: string } }).error.code).toBe('TOPIC_LIMIT_REACHED');
  });

  it('resolves subscription transitions and keeps usage operations atomic and idempotent', async () => {
    const account = await user('5001');
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'pro' } });
    const subscription = await prisma.subscription.create({
      data: { userId: account.id, planId: pro.id, status: 'ACTIVE', startsAt: new Date() },
    });
    const path = '/api/v1/subscription';
    const active = await request(app.getHttpServer())
      .get(path)
      .set(signedHeaders({ telegramUserId: '5001', method: 'GET', path }))
      .expect(200);
    expect((active.body as { data: { planCode: string } }).data.planCode).toBe('pro');

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELLED' },
    });
    const fallback = await request(app.getHttpServer())
      .get(path)
      .set(signedHeaders({ telegramUserId: '5001', method: 'GET', path }))
      .expect(200);
    expect((fallback.body as { data: { planCode: string } }).data.planCode).toBe('free');

    const reserved = await usage.reserve({
      userId: account.id,
      metric: 'TEXT_GENERATION',
      amount: 2,
      operationKey: 'reserve-1',
    });
    expect(reserved.reserved).toBe(2);
    expect(
      await usage.reserve({
        userId: account.id,
        metric: 'TEXT_GENERATION',
        amount: 2,
        operationKey: 'reserve-1',
      }),
    ).toEqual(reserved);
    const committed = await usage.commit({
      userId: account.id,
      metric: 'TEXT_GENERATION',
      amount: 2,
      operationKey: 'commit-1',
    });
    expect(committed).toMatchObject({ reserved: 0, committed: 2 });
    await usage.reserve({
      userId: account.id,
      metric: 'TEXT_GENERATION',
      amount: 1,
      operationKey: 'reserve-2',
    });
    const released = await usage.release({
      userId: account.id,
      metric: 'TEXT_GENERATION',
      amount: 1,
      operationKey: 'release-2',
    });
    expect(released).toMatchObject({ reserved: 0, committed: 2 });
    expect(await prisma.usageLedgerEntry.count()).toBe(4);
  });

  it('does not exceed a usage limit under concurrent reservations', async () => {
    const account = await user('6001');
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'free' } });
    const entitlement = INITIAL_PLANS[0]?.entitlements;
    if (!entitlement) throw new Error('Expected free plan');
    await prisma.subscriptionPlan.update({
      where: { id: free.id },
      data: { entitlements: { ...entitlement, textGenerationMonthly: 1 } },
    });
    const results = await Promise.allSettled([
      usage.reserve({
        userId: account.id,
        metric: 'TEXT_GENERATION',
        amount: 1,
        operationKey: 'concurrent-1',
      }),
      usage.reserve({
        userId: account.id,
        metric: 'TEXT_GENERATION',
        amount: 1,
        operationKey: 'concurrent-2',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.usageCounter.findFirstOrThrow()).toMatchObject({
      reserved: 1,
      committed: 0,
    });
  });
});
