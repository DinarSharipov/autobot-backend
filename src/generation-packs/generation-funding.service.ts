import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CreditType, type Prisma } from '../generated/prisma/client.js';
import type { AppEnvironment } from '../config/environment.js';
import { UsageService } from '../subscriptions/usage.service.js';
import { WalletService } from './wallet.service.js';

@Injectable()
export class GenerationFundingService {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly usage: UsageService,
    private readonly wallet: WalletService,
  ) {}

  private get prepaid(): boolean {
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

  private mutate(
    action: 'reserve' | 'commit' | 'release',
    userId: string,
    creditType: CreditType,
    publicationId: string,
    database?: Prisma.TransactionClient,
    operationBase?: string,
  ) {
    const operationKey = `${operationBase ?? `publication:${publicationId}:${creditType.toLowerCase()}-generation`}:${action}`;
    if (this.prepaid) {
      return this.wallet[action](
        {
          userId,
          creditType,
          units: 1,
          operationKey,
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
      operationKey,
      metadata: { publicationId },
      ...(database ? { database } : {}),
    } as const;
    return this.usage[action](usageInput);
  }
}
