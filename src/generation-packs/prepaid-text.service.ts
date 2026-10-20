import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, Publication, TextFundingKind } from '../generated/prisma/client.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { toPublicationView } from '../posts/post.types.js';
import { RevisionAllowanceService } from './revision-allowance.service.js';
import { WalletService } from './wallet.service.js';

@Injectable()
export class PrepaidTextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly allowance: RevisionAllowanceService,
    private readonly wallet: WalletService,
  ) {}

  preview(userId: string, publicationId: string) {
    return serializableTransaction(this.prisma, async (tx) => {
      const publication = await this.owned(tx, userId, publicationId);
      const balance = await tx.generationWallet.findUnique({
        where: { userId_creditType: { userId, creditType: 'TEXT' } },
      });
      const request = await tx.moderationRequest.findFirst({
        where: { publicationId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (publication.status !== 'AWAITING_MODERATION' || !request)
        throw this.error('MODERATION_NOT_READY');
      const allowance = await this.allowance.ensure(userId, publicationId, tx);
      const remaining =
        allowance.includedTotal - allowance.includedCommitted - allowance.includedReserved;
      const units = remaining > 0 ? 0 : 1;
      const confirmation = await tx.generationCostConfirmation.create({
        data: {
          userId,
          publicationId,
          moderationRequestId: request.id,
          moderationVersion: request.version,
          allowanceVersion: allowance.version,
          units,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      return {
        publicationId,
        moderationRequestId: request.id,
        moderationVersion: request.version,
        action: units ? 'PAID_REVISION' : 'INCLUDED_REVISION',
        creditType: 'TEXT',
        units,
        includedRemaining: remaining,
        available: balance?.available ?? 0,
        debt: balance?.debt ?? 0,
        costConfirmationId: confirmation.id,
        expiresAt: confirmation.expiresAt.toISOString(),
      };
    });
  }

  async authorizeRevision(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      publicationId: string;
      requestId: string;
      version: number;
      confirmationId?: string;
    },
  ): Promise<{ kind: TextFundingKind; key: string }> {
    const allowance = await this.allowance.ensure(input.userId, input.publicationId, tx);
    const units =
      allowance.includedCommitted + allowance.includedReserved < allowance.includedTotal ? 0 : 1;
    if (input.confirmationId) {
      const confirmation = await tx.generationCostConfirmation.findUnique({
        where: { id: input.confirmationId },
      });
      if (
        !confirmation ||
        confirmation.userId !== input.userId ||
        confirmation.publicationId !== input.publicationId ||
        confirmation.moderationRequestId !== input.requestId ||
        confirmation.moderationVersion !== input.version ||
        confirmation.allowanceVersion !== allowance.version ||
        confirmation.units !== units ||
        confirmation.consumedAt ||
        confirmation.expiresAt <= new Date()
      )
        throw this.error('STALE_COST_CONFIRMATION');
      await tx.generationCostConfirmation.update({
        where: { id: confirmation.id },
        data: { consumedAt: new Date() },
      });
    } else if (units) throw this.error('COST_CONFIRMATION_REQUIRED');
    const key = `publication:${input.publicationId}:revision:${input.requestId}:v${input.version}`;
    if (!units) await this.allowance.reserve(input.userId, input.publicationId, key, tx);
    return { kind: units ? 'PAID_REVISION' : 'INCLUDED_REVISION', key };
  }

  reserve(
    tx: Prisma.TransactionClient,
    userId: string,
    publicationId: string,
    kind: TextFundingKind,
    key: string,
  ) {
    if (kind === 'INCLUDED_REVISION') return this.allowance.reserve(userId, publicationId, key, tx);
    return this.wallet.reserve(
      { userId, publicationId, creditType: 'TEXT', units: 1, operationKey: key },
      tx,
    );
  }

  async settle(
    tx: Prisma.TransactionClient,
    userId: string,
    publicationId: string,
    kind: TextFundingKind,
    key: string,
    action: 'commit' | 'release',
  ) {
    if (kind === 'INCLUDED_REVISION') await this.allowance[action](key, tx);
    else
      await this.wallet[action](
        { userId, publicationId, creditType: 'TEXT', units: 1, operationKey: key },
        tx,
      );
    if (kind === 'INITIAL_TEXT' && action === 'commit')
      await this.allowance.ensure(userId, publicationId, tx);
  }

  resume(userId: string, publicationId: string, key: string) {
    return this.idempotency.execute({
      userId,
      operation: `text.resume:${publicationId}`,
      key,
      requestHash: this.idempotency.digest({ publicationId }),
      handler: async (tx) => {
        const publication = await this.owned(tx, userId, publicationId);
        const blocked =
          publication.status === 'PENDING' && publication.fundingStatus === 'BLOCKED_FUNDS';
        const failedInitial =
          publication.status === 'FAILED' &&
          publication.textFundingKind === 'INITIAL_TEXT' &&
          !(await tx.aIRequest.count({
            where: { publicationId, kind: 'TEXT', status: 'SUCCEEDED' },
          }));
        if (!blocked && !failedInitial) throw this.error('GENERATION_NOT_RESUMABLE');
        const updated = await tx.publication.update({
          where: { id: publicationId },
          data: {
            status: 'PENDING',
            fundingStatus: 'READY',
            errorCode: null,
            version: { increment: 1 },
            ...(failedInitial
              ? { textFundingKey: `publication:${publicationId}:text-retry:${randomUUID()}` }
              : {}),
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'Publication',
            aggregateId: publicationId,
            eventType: 'publication.generation.requested.v1',
            payload: { schemaVersion: 1, publicationId },
          },
        });
        await tx.auditEvent.create({
          data: {
            userId,
            actorType: 'USER',
            actorId: userId,
            action: 'generation.resumed',
            entityType: 'Publication',
            entityId: publicationId,
          },
        });
        return toPublicationView(updated);
      },
    });
  }

  async cancelPending(tx: Prisma.TransactionClient, publication: Publication) {
    if (!publication.textFundingKey) return;
    if (publication.textFundingKind === 'INCLUDED_REVISION') {
      const hold = await tx.textRevisionAllowanceOperation.findUnique({
        where: { operationKey: publication.textFundingKey },
      });
      if (hold?.status === 'RESERVED') await this.allowance.release(hold.operationKey, tx);
    } else {
      const hold = await tx.generationReservation.findUnique({
        where: { operationKey: publication.textFundingKey },
      });
      if (hold?.status === 'RESERVED')
        await this.wallet.release(
          {
            userId: hold.userId,
            creditType: 'TEXT',
            units: hold.units,
            operationKey: hold.operationKey,
          },
          tx,
        );
    }
  }

  private async owned(tx: Prisma.TransactionClient, userId: string, publicationId: string) {
    const publication = await tx.publication.findFirst({
      where: { id: publicationId, post: { userId } },
    });
    if (!publication) throw this.error('PUBLICATION_NOT_FOUND', 404);
    if (publication.fundingMode !== 'PREPAID') throw this.error('PREPAID_NOT_APPLICABLE');
    return publication;
  }
  private error(code: string, status = 409) {
    return new ApiHttpException(status, code, 'Text generation operation could not be completed.');
  }
}
