import { Injectable } from '@nestjs/common';

import { PublicationMode } from '../generated/prisma/client.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { GenerationFundingService } from '../generation-packs/generation-funding.service.js';
import {
  TextGenerationAdapter,
  TextGenerationProviderError,
  type TextGenerationResult,
} from './text-generation.adapter.js';

type PublicationDefinition = {
  prompt: string;
  generateImage: boolean;
  publicationMode: PublicationMode;
  topicPromptTemplate: string | null;
  telegramChatId: string;
};

function definitionOf(value: unknown): PublicationDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.prompt !== 'string' ||
    typeof data.generateImage !== 'boolean' ||
    (data.publicationMode !== 'AUTO' && data.publicationMode !== 'MODERATION') ||
    (data.topicPromptTemplate !== null && typeof data.topicPromptTemplate !== 'string') ||
    typeof data.telegramChatId !== 'string'
  )
    return null;
  return data as PublicationDefinition;
}

type Claim = {
  publicationId: string;
  aiRequestId: string;
  versionId: string;
  prompt: string;
  topicPromptTemplate: string | null;
  revisionFeedback: string | null;
  previousText: string | null;
  maxCharacters: number;
  publicationMode: PublicationMode;
  generationSequence: number;
  usageCommitKey: string;
  usageReleaseKey: string;
  revisionAllowanceKey: string | null;
};

@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly adapter: TextGenerationAdapter,
    private readonly funding: GenerationFundingService,
  ) {}

  async generate(publicationId: string, retry = false): Promise<void> {
    const claim = await this.claim(publicationId, retry);
    if (!claim) return;
    let result: TextGenerationResult;
    try {
      result = await this.adapter.generate({
        prompt: claim.prompt,
        topicPromptTemplate: claim.topicPromptTemplate,
        revisionFeedback: claim.revisionFeedback,
        previousText: claim.previousText,
        maxCharacters: claim.maxCharacters,
        idempotencyKey: `publication:${claim.publicationId}:text:v${claim.generationSequence}`,
      });
    } catch (error) {
      if (error instanceof TextGenerationProviderError && error.retryable) throw error;
      await this.fail(
        claim,
        error instanceof TextGenerationProviderError ? error.code : 'AI_PROVIDER_UNEXPECTED_ERROR',
      );
      return;
    }
    // Persistence errors must reach the queue: releasing here could refund a successful generation.
    await this.succeed(claim, result);
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
    const revisionUsageSuffix = revision ? `:revision:${revision.versionId}` : '';
    await this.fail(
      {
        publicationId,
        aiRequestId: running.id,
        versionId: version.id,
        prompt: '',
        topicPromptTemplate: null,
        revisionFeedback: null,
        previousText: null,
        maxCharacters: 4096,
        publicationMode: 'AUTO',
        generationSequence: version.sequence,
        usageCommitKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:commit`,
        usageReleaseKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:release`,
        revisionAllowanceKey: revision
          ? `publication:${publicationId}:revision:${revision.versionId}:included-revision`
          : null,
      },
      code,
    );
  }

  private async claim(publicationId: string, retry: boolean): Promise<Claim | null> {
    return serializableTransaction(this.prisma, async (transaction) => {
      const publication = await transaction.publication.findUnique({
        where: { id: publicationId },
        include: { post: { include: { topic: true } } },
      });
      if (
        !publication ||
        (publication.status !== 'PENDING' && !(retry && publication.status === 'GENERATING'))
      )
        return null;
      const updated = await transaction.publication.updateMany({
        where: { id: publication.id, status: publication.status },
        data: { status: 'GENERATING' },
      });
      if (!updated.count) return null;
      const existing = retry
        ? await transaction.aIRequest.findFirst({
            where: { publicationId, kind: 'TEXT', status: 'RUNNING' },
            include: { generatedVersion: true },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      const aiRequest =
        existing ??
        (await transaction.aIRequest.create({
          data: {
            userId: publication.post.userId,
            postId: publication.postId,
            publicationId,
            kind: 'TEXT',
            provider: 'gptunnel',
            model: this.config.get('AI_TEXT_MODEL', { infer: true }),
            status: 'RUNNING',
            startedAt: new Date(),
          },
        }));
      const last = await transaction.postVersion.aggregate({
        where: { postId: publication.postId },
        _max: { sequence: true },
      });
      const revision = await transaction.moderationRequest.findFirst({
        where: { publicationId, status: 'REVISION_REQUESTED' },
        orderBy: { createdAt: 'desc' },
        include: { postVersion: true },
      });
      const generationSequence =
        existing?.generatedVersion?.sequence ?? (last._max.sequence ?? 0) + 1;
      const revisionUsageSuffix = revision ? `:revision:${revision.versionId}` : '';
      const version =
        existing?.generatedVersion ??
        (await transaction.postVersion.create({
          data: {
            postId: publication.postId,
            publicationId,
            aiRequestId: aiRequest.id,
            sequence: generationSequence,
            status: 'GENERATING',
          },
        }));
      const definition = definitionOf(publication.definition);
      return {
        publicationId,
        aiRequestId: aiRequest.id,
        versionId: version.id,
        prompt: definition?.prompt ?? publication.post.prompt,
        topicPromptTemplate:
          definition?.topicPromptTemplate ?? publication.post.topic?.promptTemplate ?? null,
        revisionFeedback: revision?.feedback ?? null,
        previousText: revision?.postVersion.text ?? null,
        maxCharacters: (definition?.generateImage ?? publication.post.generateImage) ? 1024 : 4096,
        publicationMode: definition?.publicationMode ?? publication.post.publicationMode,
        generationSequence,
        usageCommitKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:commit`,
        usageReleaseKey: `publication:${publicationId}${revisionUsageSuffix}:text-generation:release`,
        revisionAllowanceKey: revision
          ? `publication:${publicationId}:revision:${revision.versionId}:included-revision`
          : null,
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
      if (claim.revisionAllowanceKey) {
        await this.funding.commitRevisionText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageCommitKey.slice(0, -':commit'.length),
          claim.revisionAllowanceKey,
        );
      } else {
        await this.funding.commitText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageCommitKey.slice(0, -':commit'.length),
        );
        await this.funding.ensureRevisionAllowance(
          publication.post.userId,
          claim.publicationId,
          transaction,
        );
      }
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
      if (claim.revisionAllowanceKey) {
        await this.funding.releaseRevisionText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageReleaseKey.slice(0, -':release'.length),
          claim.revisionAllowanceKey,
        );
      } else {
        await this.funding.releaseText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageReleaseKey.slice(0, -':release'.length),
        );
      }
      if (publication.post.generateImage) {
        await this.funding.releaseImage(publication.post.userId, claim.publicationId, transaction);
      }
    });
  }
}
