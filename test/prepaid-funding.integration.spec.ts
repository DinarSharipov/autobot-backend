import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureApplication } from '../src/bootstrap.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import { IdentityService } from '../src/users/identity.service.js';
import { ModerationService } from '../src/moderation/moderation.service.js';
import { PublishingService } from '../src/publishing/publishing.service.js';
import { PostsService } from '../src/posts/posts.service.js';
import { SchedulesService } from '../src/schedules/schedules.service.js';
import { PlanProvisioningService } from '../src/subscriptions/plan-provisioning.service.js';
import {
  TelegramPublicationAdapter,
  TelegramPublicationError,
} from '../src/publishing/telegram-publication.adapter.js';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { GenerationFundingService } from '../src/generation-packs/generation-funding.service.js';
import { RevisionAllowanceService } from '../src/generation-packs/revision-allowance.service.js';
import { PrepaidTextService } from '../src/generation-packs/prepaid-text.service.js';
import { WalletService } from '../src/generation-packs/wallet.service.js';
import { GenerationService } from '../src/generation/generation.service.js';
import {
  TextGenerationAdapter,
  TextGenerationProviderError,
} from '../src/generation/text-generation.adapter.js';
import { withoutBackgroundJobs } from './support/without-background-jobs.js';
import { cleanTestDatabase } from './support/test-database.js';

describe('prepaid funding reservations through PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let funding: GenerationFundingService;
  let allowance: RevisionAllowanceService;
  let wallet: WalletService;
  let generation: GenerationService;
  let userId: string;
  let publicationId: string;
  const telegram = { sendText: vi.fn(), sendPhoto: vi.fn() };
  const adapter = { generate: vi.fn() };
  const result = {
    text: 'Generated text',
    providerRequestId: 'test-result',
    inputUnits: 10,
    outputUnits: 5,
  };

  beforeAll(async () => {
    const module = await withoutBackgroundJobs(Test.createTestingModule({ imports: [AppModule] }))
      .overrideProvider(TelegramPublicationAdapter)
      .useValue(telegram)
      .overrideProvider(TextGenerationAdapter)
      .useValue(adapter)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApplication(app, { swagger: false });
    await app.init();
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', true);
    prisma = app.get(PrismaService);
    funding = app.get(GenerationFundingService);
    allowance = app.get(RevisionAllowanceService);
    wallet = app.get(WalletService);
    generation = app.get(GenerationService);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    adapter.generate.mockReset().mockResolvedValue(result);
    telegram.sendText
      .mockReset()
      .mockResolvedValue({ chatId: BigInt(123456), messageId: BigInt(99) });
    telegram.sendPhoto.mockReset();
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', true);
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    const user = await app.get(IdentityService).resolveBotUser({ telegramUserId: '1234567' });
    userId = user.id;
    const channel = await prisma.channel.create({
      data: { userId, telegramChatId: BigInt(123456), title: 'Test' },
    });
    const post = await prisma.post.create({
      data: { userId, channelId: channel.id, prompt: 'Test prompt', publicationMode: 'AUTO' },
    });
    const publication = await prisma.publication.create({
      data: { postId: post.id, fundingMode: 'PREPAID', scheduledFor: new Date() },
    });
    publicationId = publication.id;
    for (const creditType of ['TEXT', 'IMAGE'] as const) {
      await wallet.grant({
        userId,
        creditType,
        units: 3,
        operationKey: `test:${creditType}:${randomUUID()}`,
        kind: 'GIFT',
      });
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['TEXT', 'IMAGE'] as const)(
    'reserves and commits %s once with the same durable key',
    async (type) => {
      const reserve =
        type === 'TEXT' ? funding.reserveText.bind(funding) : funding.reserveImage.bind(funding);
      const commit =
        type === 'TEXT' ? funding.commitText.bind(funding) : funding.commitImage.bind(funding);
      await reserve(userId, publicationId);
      await reserve(userId, publicationId);
      await Promise.all([commit(userId, publicationId), commit(userId, publicationId)]);
      expect(
        await prisma.generationWallet.findUniqueOrThrow({
          where: { userId_creditType: { userId, creditType: type } },
        }),
      ).toMatchObject({ available: 2, reserved: 0 });
      expect(
        await prisma.generationReservation.findMany({ where: { publicationId } }),
      ).toMatchObject([{ status: 'COMMITTED' }]);
      const entries = await prisma.creditLedgerEntry.findMany({
        where: { publicationId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((entry) => entry.kind)).toEqual(['RESERVE', 'COMMIT']);
    },
  );

  it.each(['TEXT', 'IMAGE'] as const)(
    'releases %s once, including a custom operation base',
    async (type) => {
      const reserve =
        type === 'TEXT' ? funding.reserveText.bind(funding) : funding.reserveImage.bind(funding);
      const release =
        type === 'TEXT' ? funding.releaseText.bind(funding) : funding.releaseImage.bind(funding);
      const key = `publication:${publicationId}:replacement:1`;
      await reserve(userId, publicationId, undefined, key);
      await Promise.all([
        release(userId, publicationId, undefined, key),
        release(userId, publicationId, undefined, key),
      ]);
      expect(
        await prisma.generationWallet.findUniqueOrThrow({
          where: { userId_creditType: { userId, creditType: type } },
        }),
      ).toMatchObject({ available: 3, reserved: 0 });
      expect(
        await prisma.generationReservation.findUniqueOrThrow({ where: { operationKey: key } }),
      ).toMatchObject({ status: 'RELEASED' });
      expect(
        await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'RELEASE' } }),
      ).toBe(1);
      await expect(reserve(userId, publicationId, undefined, key)).rejects.toMatchObject({
        response: { code: 'CREDIT_RESERVATION_ALREADY_SETTLED' },
      });
    },
  );

  it('allows only one concurrent reservation of the last included revision', async () => {
    for (const key of ['first', 'second']) {
      await allowance.reserve(userId, publicationId, key);
      await allowance.commit(key);
    }
    const attempts = await Promise.allSettled(
      ['third-a', 'third-b'].map((key) => allowance.reserve(userId, publicationId, key)),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { response: { code: 'REVISION_ALLOWANCE_EXHAUSTED' } },
    });
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 2, includedReserved: 1 });
    expect(await prisma.textRevisionAllowanceOperation.count()).toBe(3);
  });

  it('releases an included revision idempotently and makes its slot available again', async () => {
    await Promise.all([
      allowance.reserve(userId, publicationId, 'same'),
      allowance.reserve(userId, publicationId, 'same'),
    ]);
    await Promise.all([allowance.release('same'), allowance.release('same')]);
    await allowance.reserve(userId, publicationId, 'next');
    await Promise.all([allowance.commit('next'), allowance.commit('next')]);
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 1, includedReserved: 0 });
    await expect(allowance.reserve(userId, publicationId, 'same')).rejects.toMatchObject({
      response: { code: 'REVISION_ALLOWANCE_OPERATION_KEY_REUSED' },
    });
  });

  it('rejects all further included revisions after three commits without a database constraint error', async () => {
    for (const key of ['a', 'b', 'c']) {
      await allowance.reserve(userId, publicationId, key);
      await allowance.commit(key);
    }
    await expect(allowance.reserve(userId, publicationId, 'd')).rejects.toMatchObject({
      response: { code: 'REVISION_ALLOWANCE_EXHAUSTED' },
    });
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 3, includedReserved: 0 });
  });

  it('does not allow another user to acquire or reuse an occurrence allowance', async () => {
    await allowance.ensure(userId, publicationId);
    const other = await prisma.user.create({ data: {} });
    await expect(allowance.ensure(other.id, publicationId)).rejects.toMatchObject({
      response: { code: 'REVISION_ALLOWANCE_OPERATION_KEY_REUSED' },
    });
    await expect(allowance.reserve(other.id, publicationId, 'foreign')).rejects.toMatchObject({
      response: { code: 'REVISION_ALLOWANCE_OPERATION_KEY_REUSED' },
    });
    expect(await prisma.textRevisionAllowanceOperation.count()).toBe(0);
  });

  it('commits successful generation once even when the job is delivered again', async () => {
    await funding.reserveText(userId, publicationId);
    await generation.generate(publicationId);
    await generation.generate(publicationId, true);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'READY' });
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 2, reserved: 0 });
  });

  it('keeps the hold and running attempt if persisting a successful provider result fails', async () => {
    await funding.reserveText(userId, publicationId);
    const commit = vi
      .spyOn(app.get(PrepaidTextService), 'settle')
      .mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(generation.generate(publicationId)).rejects.toThrow('Database unavailable');
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'GENERATING' });
    expect(await prisma.aIRequest.findFirstOrThrow({ where: { publicationId } })).toMatchObject({
      status: 'RUNNING',
    });
    expect(
      await prisma.generationReservation.findFirstOrThrow({ where: { publicationId } }),
    ).toMatchObject({ status: 'RESERVED' });
    commit.mockRestore();
    await generation.generate(publicationId, true);
    expect(adapter.generate).toHaveBeenCalledTimes(2);
    expect(adapter.generate.mock.calls[1]).toEqual(adapter.generate.mock.calls[0]);
    expect(await prisma.aIRequest.count({ where: { publicationId } })).toBe(1);
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      1,
    );
  });

  it('retains a hold across transient provider errors and releases it on terminal failure', async () => {
    await funding.reserveText(userId, publicationId);
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_TIMEOUT', true),
    );
    await expect(generation.generate(publicationId)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(
      await prisma.generationReservation.findFirstOrThrow({ where: { publicationId } }),
    ).toMatchObject({ status: 'RESERVED' });
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_REJECTED', false),
    );
    await generation.generate(publicationId, true);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_REJECTED' });
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 3, reserved: 0 });
    expect(
      await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'RELEASE' } }),
    ).toBe(1);
  });
  async function pending() {
    return prisma.moderationRequest.findFirstOrThrow({
      where: { publicationId, status: 'PENDING' },
    });
  }
  async function moderated() {
    const pub = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    await prisma.post.update({
      where: { id: pub.postId },
      data: { publicationMode: 'MODERATION' },
    });
    await generation.generate(publicationId);
    return pending();
  }
  async function revise(confirmationId?: string) {
    const source = await pending();
    return app
      .get(ModerationService)
      .requestRevision(
        userId,
        source.id,
        source.version,
        'Make it clearer',
        randomUUID(),
        confirmationId,
      );
  }
  async function exhaustIncluded() {
    await moderated();
    for (let i = 0; i < 3; i++) {
      await revise();
      await generation.generate(publicationId);
    }
  }
  function signed(
    path: string,
    body?: unknown,
    key = randomUUID(),
    telegramId = '1234567',
    version?: number,
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const canonical = canonicalBotRequest({
      method: 'POST',
      originalUrl: path,
      body: Buffer.from(raw),
      timestamp,
      nonce,
      telegramUserId: telegramId,
    });
    const call = request(app.getHttpServer())
      .post(path)
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

  it('includes exactly three successful revisions, then requires explicit paid approval through REST', async () => {
    await exhaustIncluded();
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 3, includedReserved: 0 });
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 2, reserved: 0 });
    const source = await pending();
    const path = `/api/v1/moderation/${source.id}/revision`;
    const missing = await signed(
      path,
      { feedback: 'Paid change' },
      randomUUID(),
      '1234567',
      source.version,
    ).expect(409);
    expect(missing.body).toMatchObject({ error: { code: 'COST_CONFIRMATION_REQUIRED' } });
    const preview = await signed(
      `/api/v1/publications/${publicationId}/generation-cost-preview`,
    ).expect(200);
    const quote = (preview.body as { data: { costConfirmationId: string; units: number } }).data;
    expect(quote.units).toBe(1);
    const key = randomUUID();
    const payload = { feedback: 'Paid change', costConfirmationId: quote.costConfirmationId };
    const accepted = await signed(path, payload, key, '1234567', source.version).expect(202);
    const replay = await signed(path, payload, key, '1234567', source.version).expect(202);
    expect(replay.body).toEqual(accepted.body);
    await generation.generate(publicationId);
    await generation.generate(publicationId);
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 1, reserved: 0 });
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      2,
    );
    await expect(revise(quote.costConfirmationId)).rejects.toMatchObject({
      response: { code: 'STALE_COST_CONFIRMATION' },
    });
  });

  it.each(['expired', 'allowance-changed', 'foreign-owner'] as const)(
    'rejects a %s paid confirmation without changing moderation or spending',
    async (reason) => {
      await exhaustIncluded();
      const quote = await app.get(PrepaidTextService).preview(userId, publicationId);
      if (reason === 'expired')
        await prisma.generationCostConfirmation.update({
          where: { id: quote.costConfirmationId },
          data: { expiresAt: new Date(0) },
        });
      if (reason === 'allowance-changed')
        await prisma.textRevisionAllowance.update({
          where: { publicationId },
          data: { version: { increment: 1 } },
        });
      if (reason === 'foreign-owner') {
        const other = await prisma.user.create({ data: {} });
        await prisma.generationCostConfirmation.update({
          where: { id: quote.costConfirmationId },
          data: { userId: other.id },
        });
      }
      await expect(revise(quote.costConfirmationId)).rejects.toMatchObject({
        response: { code: 'STALE_COST_CONFIRMATION' },
      });
      expect((await pending()).status).toBe('PENDING');
      expect(
        await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } }),
      ).toBe(1);
    },
  );

  it('never upgrades a free confirmation silently to a paid revision', async () => {
    await moderated();
    const free = await app.get(PrepaidTextService).preview(userId, publicationId);
    expect(free.units).toBe(0);
    for (let i = 0; i < 3; i++) {
      await revise();
      await generation.generate(publicationId);
    }
    await expect(revise(free.costConfirmationId)).rejects.toMatchObject({
      response: { code: 'STALE_COST_CONFIRMATION' },
    });
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      1,
    );
  });

  it('blocks unfunded initial work before a provider call and resumes the same occurrence idempotently', async () => {
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'TEXT' },
      data: { available: 0 },
    });
    await generation.generate(publicationId);
    await generation.generate(publicationId);
    expect(adapter.generate).not.toHaveBeenCalled();
    expect(await prisma.aIRequest.count()).toBe(0);
    expect(await app.get(PublishingService).get(userId, publicationId)).toMatchObject({
      status: 'PENDING',
      fundingMode: 'PREPAID',
      fundingStatus: 'BLOCKED_FUNDS',
      errorCode: 'INSUFFICIENT_TEXT_CREDITS',
    });
    await wallet.grant({
      userId,
      creditType: 'TEXT',
      units: 1,
      operationKey: randomUUID(),
      kind: 'PURCHASE',
    });
    const key = randomUUID();
    const path = `/api/v1/publications/${publicationId}/generation/resume`;
    const resumed = await signed(path, undefined, key).expect(202);
    const replay = await signed(path, undefined, key).expect(202);
    expect(replay.body).toEqual(resumed.body);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: publicationId } })).toBe(1);
    await generation.generate(publicationId);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
    expect(await prisma.publication.count()).toBe(1);
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      1,
    );
  });

  it('retains an approved paid intent while blocked even after its confirmation expires', async () => {
    await exhaustIncluded();
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'TEXT' },
      data: { available: 0 },
    });
    const quote = await app.get(PrepaidTextService).preview(userId, publicationId);
    await revise(quote.costConfirmationId);
    const approved = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    await generation.generate(publicationId);
    expect(adapter.generate).toHaveBeenCalledTimes(4);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ fundingStatus: 'BLOCKED_FUNDS', textFundingKey: approved.textFundingKey });
    await prisma.generationCostConfirmation.update({
      where: { id: quote.costConfirmationId },
      data: { expiresAt: new Date(0) },
    });
    await wallet.grant({
      userId,
      creditType: 'TEXT',
      units: 1,
      operationKey: randomUUID(),
      kind: 'PURCHASE',
    });
    await app.get(PrepaidTextService).resume(userId, publicationId, randomUUID());
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', false);
    await generation.generate(publicationId);
    expect(adapter.generate).toHaveBeenCalledTimes(5);
    expect(
      await prisma.generationReservation.findUniqueOrThrow({
        where: { operationKey: approved.textFundingKey! },
      }),
    ).toMatchObject({ status: 'COMMITTED' });
  });

  it('restores the included slot and moderation after a terminal revision failure', async () => {
    await moderated();
    const original = await pending();
    await revise();
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_REJECTED', false),
    );
    await generation.generate(publicationId);
    expect(await pending()).toMatchObject({ id: original.id, version: original.version + 2 });
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'AWAITING_MODERATION' });
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 0, includedReserved: 0 });
    await revise();
    await generation.generate(publicationId);
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 1, includedReserved: 0 });
  });

  it('releases a failed paid revision and requires a new confirmation for its next attempt', async () => {
    await exhaustIncluded();
    const quote = await app.get(PrepaidTextService).preview(userId, publicationId);
    await revise(quote.costConfirmationId);
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_REJECTED', false),
    );
    await generation.generate(publicationId);
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 2, reserved: 0 });
    await expect(revise()).rejects.toMatchObject({
      response: { code: 'COST_CONFIRMATION_REQUIRED' },
    });
    const next = await app.get(PrepaidTextService).preview(userId, publicationId);
    await revise(next.costConfirmationId);
    await generation.generate(publicationId);
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      2,
    );
  });

  it('resumes failed initial generation with a new reservation key', async () => {
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_REJECTED', false),
    );
    await generation.generate(publicationId);
    const failed = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    await app.get(PrepaidTextService).resume(userId, publicationId, randomUUID());
    await generation.generate(publicationId);
    const done = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    expect(done.textFundingKey).not.toBe(failed.textFundingKey);
    expect(done.status).toBe('READY');
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      1,
    );
  });

  it('allows only one worker to spend the last TEXT credit', async () => {
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'TEXT' },
      data: { available: 1 },
    });
    const original = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    const other = await prisma.publication.create({
      data: { postId: original.postId, scheduledFor: new Date(), fundingMode: 'PREPAID' },
    });
    await Promise.all([generation.generate(publicationId), generation.generate(other.id)]);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
    expect(await prisma.publication.count({ where: { fundingStatus: 'BLOCKED_FUNDS' } })).toBe(1);
    expect(
      await prisma.generationWallet.findUniqueOrThrow({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      }),
    ).toMatchObject({ available: 0, reserved: 0 });
  });

  it('releases a pending included revision when cancelled and permits cancelling a blocked publication', async () => {
    await moderated();
    await revise();
    await app.get(PublishingService).cancel(userId, publicationId, randomUUID());
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 0, includedReserved: 0 });
    await generation.generate(publicationId);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
    const original = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    const blocked = await prisma.publication.create({
      data: {
        postId: original.postId,
        scheduledFor: new Date(),
        fundingMode: 'PREPAID',
        fundingStatus: 'BLOCKED_FUNDS',
      },
    });
    expect(await app.get(PublishingService).cancel(userId, blocked.id, randomUUID())).toMatchObject(
      { status: 'CANCELLED' },
    );
  });

  it('enforces ownership and authentication on preview and resume routes', async () => {
    await moderated();
    await app.get(IdentityService).resolveBotUser({ telegramUserId: '7654321' });
    for (const suffix of ['generation-cost-preview', 'generation/resume']) {
      const path = `/api/v1/publications/${publicationId}/${suffix}`;
      await signed(path, undefined, randomUUID(), '7654321').expect(404);
      await request(app.getHttpServer()).post(path).expect(401);
    }
    expect(await prisma.generationCostConfirmation.count()).toBe(0);
  });

  it('retries text delivery without another generation debit', async () => {
    await generation.generate(publicationId);
    telegram.sendText.mockRejectedValueOnce(
      new TelegramPublicationError('TELEGRAM_RATE_LIMITED', true, false, 1),
    );
    await app.get(PublishingService).publish(publicationId);
    await prisma.publication.update({
      where: { id: publicationId },
      data: { nextAttemptAt: new Date(0) },
    });
    await app.get(PublishingService).publish(publicationId);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'PUBLISHED' });
    expect(await prisma.creditLedgerEntry.count({ where: { publicationId, kind: 'COMMIT' } })).toBe(
      1,
    );
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps prepaid image delivery closed until the media preview slice', async () => {
    const original = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    await prisma.post.update({ where: { id: original.postId }, data: { generateImage: true } });
    await generation.generate(publicationId);
    await app.get(PublishingService).publish(publicationId);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_UNAVAILABLE' });
    expect(telegram.sendPhoto).not.toHaveBeenCalled();
    expect(await prisma.generationReservation.count({ where: { creditType: 'IMAGE' } })).toBe(0);
  });

  it('materializes prepaid schedules with no funds without reserving or stalling the schedule', async () => {
    const original = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    const now = new Date();
    const schedule = await prisma.postSchedule.create({
      data: {
        postId: original.postId,
        kind: 'ONCE',
        timezone: 'UTC',
        runAt: now,
        nextRunAt: now,
        misfirePolicy: 'FIRE_ONCE',
        misfireGraceSeconds: 60,
      },
    });
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'TEXT' },
      data: { available: 0 },
    });
    expect(await app.get(SchedulesService).materializeDue(now)).toBe(1);
    expect(
      await prisma.postSchedule.findUniqueOrThrow({ where: { id: schedule.id } }),
    ).toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.generationReservation.count()).toBe(0);
    const occurrence = await prisma.publication.findFirstOrThrow({
      where: { scheduleId: schedule.id },
    });
    await generation.generate(occurrence.id);
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({ fundingStatus: 'BLOCKED_FUNDS' });
  });

  it('defers immediate prepaid reservation until the worker and preserves legacy funding across flag changes', async () => {
    await app.get(PlanProvisioningService).provision();
    const original = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    const post = await prisma.post.update({
      where: { id: original.postId },
      data: { status: 'ACTIVE' },
    });
    await prisma.channel.update({ where: { id: post.channelId }, data: { status: 'ACTIVE' } });
    const fresh = await app
      .get(PostsService)
      .createImmediatePublication(userId, post.id, post.version, randomUUID());
    expect(fresh.fundingMode).toBe('PREPAID');
    expect(await prisma.generationReservation.count()).toBe(0);
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', false);
    const legacy = await app
      .get(PostsService)
      .createImmediatePublication(userId, post.id, post.version, randomUUID());
    expect(legacy.fundingMode).toBe('LEGACY');
    app.get(ConfigService).set('PREPAID_GENERATION_ENABLED', true);
    await generation.generate(legacy.id);
    expect(
      await prisma.usageCounter.findFirstOrThrow({ where: { userId, metric: 'TEXT_GENERATION' } }),
    ).toMatchObject({ reserved: 0, committed: 1 });
    expect(await prisma.generationReservation.count()).toBe(0);
  });
  it('blocks new text work while refund debt is outstanding', async () => {
    await prisma.generationWallet.updateMany({
      where: { userId, creditType: 'TEXT' },
      data: { debt: 1 },
    });
    await generation.generate(publicationId);
    expect(adapter.generate).not.toHaveBeenCalled();
    expect(
      await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
    ).toMatchObject({ fundingStatus: 'BLOCKED_FUNDS' });
    await wallet.grant({
      userId,
      creditType: 'TEXT',
      units: 1,
      operationKey: randomUUID(),
      kind: 'PURCHASE',
    });
    await app.get(PrepaidTextService).resume(userId, publicationId, randomUUID());
    await generation.generate(publicationId);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('returns the included slot after invalid provider output or retry exhaustion', async () => {
    await moderated();
    await revise();
    adapter.generate.mockResolvedValueOnce({ ...result, text: '   ' });
    await generation.generate(publicationId);
    expect(await pending()).toBeDefined();
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 0, includedReserved: 0 });
    await revise();
    adapter.generate.mockRejectedValueOnce(
      new TextGenerationProviderError('PROVIDER_TIMEOUT', true),
    );
    await expect(generation.generate(publicationId)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    await generation.failAfterRetries(publicationId, 'PROVIDER_TIMEOUT');
    await generation.failAfterRetries(publicationId, 'PROVIDER_TIMEOUT');
    expect(await pending()).toBeDefined();
    expect(
      await prisma.textRevisionAllowance.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ includedCommitted: 0, includedReserved: 0 });
  });

  it('reconciles published outbox events without requeueing blocked work', async () => {
    const { OutboxDispatcherService } =
      await import('../src/generation/outbox-dispatcher.service.js');
    const queue = { getJob: vi.fn().mockResolvedValue(null), add: vi.fn() };
    const dispatcher = new OutboxDispatcherService(prisma, app.get(ConfigService), queue as never);
    await prisma.publication.update({
      where: { id: publicationId },
      data: { fundingStatus: 'BLOCKED_FUNDS' },
    });
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'Publication',
        aggregateId: publicationId,
        eventType: 'publication.generation.requested.v1',
        status: 'PUBLISHED',
        payload: { schemaVersion: 1, publicationId },
      },
    });
    await dispatcher.dispatchPending();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('supports transactional schema rollback only before any prepaid publication exists', async () => {
    const sql = await readFile(
      new URL('../prisma/rollback/20261020150000_prepaid_text_confirmation.sql', import.meta.url),
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
      const removed = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Publication' AND column_name = 'fundingMode') AS present`,
      );
      expect(removed.rows[0]?.present).toBe(false);
      await client.query('ROLLBACK');
      expect(
        await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } }),
      ).toMatchObject({ fundingMode: 'LEGACY' });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
  it('dispatches a new resume event even when an old published batch is full', async () => {
    const { OutboxDispatcherService } =
      await import('../src/generation/outbox-dispatcher.service.js');
    const queue = { getJob: vi.fn().mockResolvedValue({ id: 'existing-job' }), add: vi.fn() };
    const dispatcher = new OutboxDispatcherService(prisma, app.get(ConfigService), queue as never);
    await prisma.outboxEvent.createMany({
      data: Array.from({ length: 50 }, () => ({
        aggregateType: 'Publication',
        aggregateId: publicationId,
        eventType: 'publication.generation.requested.v1',
        status: 'PUBLISHED' as const,
        payload: { schemaVersion: 1, publicationId },
        createdAt: new Date(0),
        availableAt: new Date(0),
      })),
    });
    const fresh = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'Publication',
        aggregateId: publicationId,
        eventType: 'publication.generation.requested.v1',
        payload: { schemaVersion: 1, publicationId },
      },
    });
    await dispatcher.dispatchPending();
    expect(queue.add).toHaveBeenCalledWith(
      'generate-post',
      { schemaVersion: 1, publicationId },
      expect.objectContaining({ jobId: `generation-${fresh.id}` }),
    );
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({
      status: 'PUBLISHED',
    });
    expect(
      await prisma.outboxEvent.count({
        where: { status: 'PUBLISHED', createdAt: new Date(0), availableAt: { gt: new Date(0) } },
      }),
    ).toBe(50);
  });
});
