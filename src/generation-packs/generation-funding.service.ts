import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CreditType, type Prisma } from '../generated/prisma/client.js';
import type { AppEnvironment } from '../config/environment.js';
import { UsageService } from '../subscriptions/usage.service.js';
import { WalletService } from './wallet.service.js';
import { RevisionAllowanceService } from './revision-allowance.service.js';

@Injectable()
export class GenerationFundingService {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly usage: UsageService,
    private readonly wallet: WalletService,
    private readonly allowance: RevisionAllowanceService,
  ) {}

  get isPrepaid(): boolean {
    return this.config.get('PREPAID_GENERATION_ENABLED', { infer: true });
  }

  reserveText(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('reserve', userId, CreditType.TEXT, publicationId, database, operationBase);
  }

  reserveImage(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('reserve', userId, CreditType.IMAGE, publicationId, database, operationBase);
  }

  commitText(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('commit', userId, CreditType.TEXT, publicationId, database, operationBase);
  }

  commitImage(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('commit', userId, CreditType.IMAGE, publicationId, database, operationBase);
  }

  releaseText(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('release', userId, CreditType.TEXT, publicationId, database, operationBase);
  }

  releaseImage(
    userId: string,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    return this.mutate('release', userId, CreditType.IMAGE, publicationId, database, operationBase);
  }

  ensureRevisionAllowance(
    userId: string,
    publicationId: string,
    database: Prisma.TransactionClient,
  ) {
    return this.allowance.ensure(userId, publicationId, database);
  }

  reserveRevision(
    userId: string,
    publicationId: string,
    operationKey: string,
    database?: Prisma.TransactionClient,
  ) {
    if (this.isPrepaid)
      return this.allowance.reserve(userId, publicationId, operationKey, database);
    return this.usage.reserve({
      userId,
      metric: 'MODERATION_REVISION',
      amount: 1,
      operationKey,
      metadata: { publicationId },
      ...(database ? { database } : {}),
    });
  }

  commitRevisionText(
    userId: string,
    publicationId: string,
    database: Prisma.TransactionClient,
    textOperationBase: string,
    revisionAllowanceKey: string,
  ) {
    if (this.isPrepaid) return this.allowance.commit(revisionAllowanceKey, database);
    return this.commitText(userId, publicationId, database, textOperationBase);
  }

  releaseRevisionText(
    userId: string,
    publicationId: string,
    database: Prisma.TransactionClient,
    textOperationBase: string,
    revisionAllowanceKey: string,
  ) {
    if (this.isPrepaid) return this.allowance.release(revisionAllowanceKey, database);
    return this.releaseText(userId, publicationId, database, textOperationBase);
  }

  private mutate(
    action: 'reserve' | 'commit' | 'release',
    userId: string,
    creditType: CreditType,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    const reservationKey =
      operationBase ?? `publication:${publicationId}:${creditType.toLowerCase()}-generation`;
    if (this.isPrepaid) {
      return this.wallet[action](
        {
          userId,
          creditType,
          units: 1,
          operationKey: reservationKey,
          publicationId,
          metadata: { publicationId },
        },
        database,
      );
    }
    const usageInput = {
      userId,
      metric: creditType === CreditType.TEXT ? 'TEXT_GENERATION' : 'IMAGE_GENERATION',
      amount: 1,
      operationKey: `${reservationKey}:${action}`,
      metadata: { publicationId },
      ...(database ? { database } : {}),
    } as const;
    return this.usage[action](usageInput);
  }
}
