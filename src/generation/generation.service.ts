import { Injectable } from '@nestjs/common';

import { PublicationMode } from '../generated/prisma/client.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { UsageService } from '../subscriptions/usage.service.js';
import { TextGenerationAdapter, TextGenerationProviderError } from './text-generation.adapter.js';

type Claim = {
  publicationId: string;
  aiRequestId: string;
  versionId: string;
  prompt: string;
  topicPromptTemplate: string | null;
  revisionFeedback: string | null;
  publicationMode: PublicationMode;
  generationSequence: number;
  usageCommitKey: string;
  usageReleaseKey: string;
};

@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly adapter: TextGenerationAdapter,
    private readonly usage: UsageService,
  ) {}

  async generate(publicationId: string): Promise<void> {
    const claim = await this.claim(publicationId);
    if (!claim) return;
    try {
      const result = await this.adapter.generate({
        prompt: claim.prompt,
        topicPromptTemplate: claim.topicPromptTemplate,
        revisionFeedback: claim.revisionFeedback,
        idempotencyKey: `publication:${claim.publicationId}:text:v${claim.generationSequence}`,
      });
      await this.succeed(claim, result);
    } catch (error) {
      if (error instanceof TextGenerationProviderError && error.retryable) throw error;
      await this.fail(
        claim,
        error instanceof TextGenerationProviderError ? error.code : 'AI_PROVIDER_UNEXPECTED_ERROR',
      );
    }
  }

  async failAfterRetries(publicationId: string, code: string): Promise<void> {
    const running = await this.prisma.aIRequest.findFirst({
      where: { publicationId, kind: 'TEXT', status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!running) return;
    const version = await this.prisma.postVersion.findUnique({
      where: { aiRequestId: running.id },
    });
    if (!version) return;
    const revision = await this.prisma.moderationRequest.findFirst({
      where: { publicationId, status: 'REVISION_REQUESTED' },
      orderBy: { createdAt: 'desc' },
    });
    const revisionUsageSuffix = revision ? `:revision:${revision.version}` : '';
    await this.fail(
      {
        publicationId,
        aiRequestId: running.id,
        versionId: version.id,
        prompt: '',
        topicPromptTemplate: null,
        revisionFeedback: null,
        publicationMode: 'AUTO',
        generationSequence: version.sequence,
        usageCommitKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:commit`,
        usageReleaseKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:release`,
      },
      code,
    );
  }

  private async claim(publicationId: string): Promise<Claim | null> {
    return serializableTransaction(this.prisma, async (transaction) => {
      const publication = await transaction.publication.findUnique({
        where: { id: publicationId },
        include: { post: { include: { topic: true } } },
      });
      if (!publication || publication.status !== 'PENDING') return null;
      const updated = await transaction.publication.updateMany({
        where: { id: publication.id, status: 'PENDING' },
        data: { status: 'GENERATING' },
      });
      if (!updated.count) return null;
      const aiRequest = await transaction.aIRequest.create({
        data: {
          userId: publication.post.userId,
          postId: publication.postId,
          publicationId,
          kind: 'TEXT',
          provider: 'openai',
          model: this.config.get('AI_TEXT_MODEL', { infer: true }),
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });
      const last = await transaction.postVersion.aggregate({
        where: { postId: publication.postId },
        _max: { sequence: true },
      });
      const revision = await transaction.moderationRequest.findFirst({
        where: { publicationId, status: 'REVISION_REQUESTED' },
        orderBy: { createdAt: 'desc' },
      });
      const generationSequence = (last._max.sequence ?? 0) + 1;
      const revisionUsageSuffix = revision ? `:revision:${revision.version}` : '';
      const version = await transaction.postVersion.create({
        data: {
          postId: publication.postId,
          publicationId,
          aiRequestId: aiRequest.id,
          sequence: generationSequence,
          status: 'GENERATING',
        },
      });
      return {
        publicationId,
        aiRequestId: aiRequest.id,
        versionId: version.id,
        prompt: publication.post.prompt,
        topicPromptTemplate: publication.post.topic?.promptTemplate ?? null,
        revisionFeedback: revision?.feedback ?? null,
        publicationMode: publication.post.publicationMode,
        generationSequence,
        usageCommitKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:commit`,
        usageReleaseKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:release`,
      };
    });
  }

  private async succeed(
    claim: Claim,
    result: {
      text: string;
      providerRequestId: string | null;
      inputUnits: number | null;
      outputUnits: number | null;
    },
  ): Promise<void> {
    await serializableTransaction(this.prisma, async (transaction) => {
      const now = new Date();
      const version = await transaction.postVersion.updateMany({
        where: { id: claim.versionId, status: 'GENERATING' },
        data: {
          status: claim.publicationMode === PublicationMode.AUTO ? 'APPROVED' : 'GENERATED',
          text: result.text,
          generatedAt: now,
          ...(claim.publicationMode === PublicationMode.AUTO ? { approvedAt: now } : {}),
        },
      });
      if (!version.count) return;
      await transaction.aIRequest.updateMany({
        where: { id: claim.aiRequestId, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          providerRequestId: result.providerRequestId,
          inputUnits: result.inputUnits,
          outputUnits: result.outputUnits,
          completedAt: now,
        },
      });
      if (claim.publicationMode === PublicationMode.AUTO) {
        await transaction.publication.update({
          where: { id: claim.publicationId },
          data: { status: 'READY', selectedVersionId: claim.versionId },
        });
      } else {
        await transaction.publication.update({
          where: { id: claim.publicationId },
          data: { status: 'AWAITING_MODERATION' },
        });
      }
      if (claim.publicationMode === PublicationMode.MODERATION) {
        const publication = await transaction.publication.findUniqueOrThrow({
          where: { id: claim.publicationId },
        });
        await transaction.moderationRequest.create({
          data: {
            postId: publication.postId,
            publicationId: publication.id,
            versionId: claim.versionId,
          },
        });
      }
      const publication = await transaction.publication.findUniqueOrThrow({
        where: { id: claim.publicationId },
        include: { post: true },
      });
      await this.usage.commit({
        userId: publication.post.userId,
        metric: 'TEXT_GENERATION',
        amount: 1,
        operationKey: claim.usageCommitKey,
        metadata: { publicationId: claim.publicationId },
        database: transaction,
      });
    });
  }

  private async fail(claim: Claim, code: string): Promise<void> {
    await serializableTransaction(this.prisma, async (transaction) => {
      const version = await transaction.postVersion.updateMany({
        where: { id: claim.versionId, status: 'GENERATING' },
        data: { status: 'FAILED' },
      });
      if (!version.count) return;
      await transaction.aIRequest.updateMany({
        where: { id: claim.aiRequestId, status: 'RUNNING' },
        data: { status: 'FAILED', errorCode: code, completedAt: new Date() },
      });
      await transaction.publication.updateMany({
        where: { id: claim.publicationId, status: 'GENERATING' },
        data: { status: 'FAILED', errorCode: code },
      });
      const publication = await transaction.publication.findUniqueOrThrow({
        where: { id: claim.publicationId },
        include: { post: true },
      });
      await this.usage.release({
        userId: publication.post.userId,
        metric: 'TEXT_GENERATION',
        amount: 1,
        operationKey: claim.usageReleaseKey,
        metadata: { publicationId: claim.publicationId },
        database: transaction,
      });
    });
  }
}
