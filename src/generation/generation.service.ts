import { Injectable } from '@nestjs/common';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import { mediaImageEnabled } from '../publishing/publication-media.service.js';
import { PrepaidTextService } from '../generation-packs/prepaid-text.service.js';
import { PublicationMode, type TextFundingKind } from '../generated/prisma/client.js';
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
  prepaid: boolean;
  fundingKind: TextFundingKind;
  fundingKey: string;
  sourceRequestId: string | null;
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
    private readonly prepaidText: PrepaidTextService,
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
      if (!result.text.trim() || result.text.length > claim.maxCharacters)
        throw new TextGenerationProviderError('AI_TEXT_INVALID', false);
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
    const publication = await this.prisma.publication.findUniqueOrThrow({
      where: { id: publicationId },
    });
    const revisionUsageSuffix = revision ? `:revision:${revision.versionId}` : '';
    await this.fail(
      {
        prepaid: publication.fundingMode === 'PREPAID',
        fundingKind: publication.textFundingKind,
        fundingKey: publication.textFundingKey ?? `publication:${publicationId}:text-generation`,
        sourceRequestId: publication.textRevisionRequestId,
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
        publication.fundingStatus === 'BLOCKED_FUNDS' ||
        (publication.status !== 'PENDING' && !(retry && publication.status === 'GENERATING'))
      )
        return null;
      const prepaid = publication.fundingMode === 'PREPAID';
      const fundingKey =
        publication.textFundingKey ?? `publication:${publicationId}:text-generation`;
      if (prepaid) {
        try {
          await this.prepaidText.reserve(
            transaction,
            publication.post.userId,
            publicationId,
            publication.textFundingKind,
            fundingKey,
          );
        } catch (error) {
          if (
            !(error instanceof ApiHttpException) ||
            !['INSUFFICIENT_TEXT_CREDITS'].includes(
              String((error.getResponse() as { code?: string }).code),
            )
          )
            throw error;
          await transaction.publication.update({
            where: { id: publicationId },
            data: {
              status: 'PENDING',
              fundingStatus: 'BLOCKED_FUNDS',
              errorCode: 'INSUFFICIENT_TEXT_CREDITS',
              version: { increment: 1 },
            },
          });
          await transaction.auditEvent.create({
            data: {
              actorType: 'SYSTEM',
              actorId: 'generation-worker',
              action: 'generation.blocked_funds',
              entityType: 'Publication',
              entityId: publicationId,
              metadata: { creditType: 'TEXT', units: 1 },
            },
          });
          return null;
        }
      }
      const updated = await transaction.publication.updateMany({
        where: { id: publication.id, status: publication.status },
        data: { status: 'GENERATING', ...(prepaid ? { textFundingKey: fundingKey } : {}) },
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
        where: prepaid
          ? { id: publication.textRevisionRequestId ?? '00000000-0000-0000-0000-000000000000' }
          : { publicationId, status: 'REVISION_REQUESTED' },
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
            ...(revision ? { sourceVersionId: revision.versionId } : {}),
          },
        }));
      const definition = definitionOf(publication.definition);
      return {
        prepaid,
        fundingKind: publication.textFundingKind,
        fundingKey,
        sourceRequestId: publication.textRevisionRequestId,
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
          data: { status: 'READY', selectedVersionId: claim.versionId, version: { increment: 1 } },
        });
      } else {
        await transaction.publication.update({
          where: { id: claim.publicationId },
          data: { status: 'AWAITING_MODERATION', version: { increment: 1 } },
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
      if (claim.prepaid && claim.fundingKind === 'INITIAL_TEXT' && mediaImageEnabled(publication)) {
        await transaction.publicationMedia.create({
          data: {
            publicationId: publication.id,
            sourceVersionId: claim.versionId,
            generationOperationKey: `publication:${publication.id}:image:initial`,
          },
        });
        if (claim.publicationMode === 'AUTO')
          await transaction.publication.update({
            where: { id: publication.id },
            data: { status: 'AWAITING_MEDIA' },
          });
      }
      if (claim.prepaid) {
        await this.prepaidText.settle(
          transaction,
          publication.post.userId,
          claim.publicationId,
          claim.fundingKind,
          claim.fundingKey,
          'commit',
        );
      } else {
        await this.funding.commitText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageCommitKey.slice(0, -':commit'.length),
          false,
        );
        if (!claim.revisionAllowanceKey)
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
      if (claim.prepaid) {
        await this.prepaidText.settle(
          transaction,
          publication.post.userId,
          claim.publicationId,
          claim.fundingKind,
          claim.fundingKey,
          'release',
        );
        if (claim.sourceRequestId) {
          const source = await transaction.moderationRequest.update({
            where: { id: claim.sourceRequestId },
            data: {
              status: 'PENDING',
              version: { increment: 1 },
              feedback: null,
              decidedAt: null,
              decidedByUserId: null,
            },
          });
          await transaction.postVersion.update({
            where: { id: source.versionId },
            data: { status: 'GENERATED' },
          });
          await transaction.publication.update({
            where: { id: claim.publicationId },
            data: {
              status: 'AWAITING_MODERATION',
              version: { increment: 1 },
              textRevisionRequestId: null,
            },
          });
        }
      } else {
        await this.funding.releaseText(
          publication.post.userId,
          claim.publicationId,
          transaction,
          claim.usageReleaseKey.slice(0, -':release'.length),
          false,
        );
        if (publication.post.generateImage)
          await this.funding.releaseImage(
            publication.post.userId,
            claim.publicationId,
            transaction,
            undefined,
            false,
          );
      }
    });
  }
}
