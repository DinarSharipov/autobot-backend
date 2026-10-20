import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { GenerationFundingService } from '../src/generation-packs/generation-funding.service.js';
import { RevisionAllowanceService } from '../src/generation-packs/revision-allowance.service.js';
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
  const adapter = { generate: vi.fn() };
  const result = {
    text: 'Generated text',
    providerRequestId: 'test-result',
    inputUnits: 10,
    outputUnits: 5,
  };

  beforeAll(async () => {
    const module = await withoutBackgroundJobs(Test.createTestingModule({ imports: [AppModule] }))
      .overrideProvider(TextGenerationAdapter)
      .useValue(adapter)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
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
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    const user = await prisma.user.create({ data: {} });
    userId = user.id;
    const channel = await prisma.channel.create({
      data: { userId, telegramChatId: BigInt(123456), title: 'Test' },
    });
    const post = await prisma.post.create({
      data: { userId, channelId: channel.id, prompt: 'Test prompt', publicationMode: 'AUTO' },
    });
    const publication = await prisma.publication.create({
      data: { postId: post.id, scheduledFor: new Date() },
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
      .spyOn(funding, 'commitText')
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
});
