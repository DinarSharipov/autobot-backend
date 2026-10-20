import { HttpStatus, Injectable } from '@nestjs/common';

import {
  CreditLedgerKind,
  CreditType,
  type Prisma,
  ReservationStatus,
} from '../generated/prisma/client.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';

export type CreditMutation = {
  userId: string;
  creditType: CreditType;
  units: number;
  operationKey: string;
  publicationId?: string;
  aiRequestId?: string;
  metadata?: Prisma.InputJsonValue;
};

export type WalletBalance = {
  creditType: CreditType;
  available: number;
  reserved: number;
  debt: number;
  version: number;
};

export type CreditGrant = {
  userId: string;
  creditType: CreditType;
  units: number;
  operationKey: string;
  kind: Extract<CreditLedgerKind, 'GIFT' | 'PURCHASE' | 'ADJUSTMENT'>;
  purchaseOrderId?: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async listPacks(creditType?: CreditType) {
    return this.prisma.generationPack.findMany({
      where: { isActive: true, ...(creditType ? { creditType } : {}) },
      orderBy: [{ creditType: 'asc' }, { units: 'asc' }, { priceMinor: 'asc' }],
      select: {
        code: true,
        creditType: true,
        units: true,
        priceMinor: true,
        currency: true,
        version: true,
      },
    });
  }

  async balances(userId: string): Promise<WalletBalance[]> {
    await this.grantOnboardingGift(userId);
    const wallets = await this.prisma.generationWallet.findMany({
      where: { userId },
      select: { creditType: true, available: true, reserved: true, debt: true, version: true },
    });
    const byType = new Map(wallets.map((wallet) => [wallet.creditType, wallet]));
    return Object.values(CreditType).map((creditType) => {
      const wallet = byType.get(creditType);
      return {
        creditType,
        available: wallet?.available ?? 0,
        reserved: wallet?.reserved ?? 0,
        debt: wallet?.debt ?? 0,
        version: wallet?.version ?? 0,
      };
    });
  }

  async grantOnboardingGift(userId: string): Promise<void> {
    await Promise.all([
      this.grant({
        userId,
        creditType: CreditType.TEXT,
        units: 3,
        operationKey: `onboarding:${userId}:text`,
        kind: 'GIFT',
        metadata: { reason: 'onboarding' },
      }),
      this.grant({
        userId,
        creditType: CreditType.IMAGE,
        units: 1,
        operationKey: `onboarding:${userId}:image`,
        kind: 'GIFT',
        metadata: { reason: 'onboarding' },
      }),
    ]);
  }

  async ledger(userId: string, creditType?: CreditType, limit = 50) {
    return this.prisma.creditLedgerEntry.findMany({
      where: { wallet: { userId, ...(creditType ? { creditType } : {}) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        kind: true,
        units: true,
        operationKey: true,
        publicationId: true,
        purchaseOrderId: true,
        createdAt: true,
        wallet: { select: { creditType: true } },
      },
    });
  }

  reserve(input: CreditMutation, database?: Prisma.TransactionClient) {
    return this.mutate(input, 'reserve', database);
  }

  commit(input: CreditMutation, database?: Prisma.TransactionClient) {
    return this.mutate(input, 'commit', database);
  }

  release(input: CreditMutation, database?: Prisma.TransactionClient) {
    return this.mutate(input, 'release', database);
  }

  async grant(input: CreditGrant, database?: Prisma.TransactionClient): Promise<WalletBalance> {
    this.assertInput(input);
    const operation = async (transaction: Prisma.TransactionClient) => {
      const wallet = await this.ensureWallet(transaction, input.userId, input.creditType);
      const existing = await transaction.creditLedgerEntry.findUnique({
        where: { walletId_operationKey: { walletId: wallet.id, operationKey: input.operationKey } },
      });
      if (existing) {
        if (existing.kind !== input.kind || existing.units !== input.units) {
          throw new ApiHttpException(
            HttpStatus.CONFLICT,
            'CREDIT_OPERATION_KEY_REUSED',
            'The credit operation key was reused with different parameters.',
          );
        }
        return this.balance(wallet);
      }
      const debtRepaid = Math.min(wallet.debt ?? 0, input.units);
      const updated = await transaction.generationWallet.update({
        where: { id: wallet.id },
        data: {
          available: { increment: input.units - debtRepaid },
          debt: { decrement: debtRepaid },
          version: { increment: 1 },
        },
      });
      await transaction.creditLedgerEntry.create({
        data: {
          walletId: wallet.id,
          kind: input.kind,
          units: input.units,
          operationKey: input.operationKey,
          ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      return this.balance(updated);
    };
    return database ? operation(database) : serializableTransaction(this.prisma, operation);
  }

  async compensateRefund(
    input: {
      userId: string;
      creditType: CreditType;
      units: number;
      purchaseOrderId: string;
      providerRefundId: string;
    },
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    const operationKey = `refund:${input.providerRefundId}`;
    this.assertInput({ units: input.units, operationKey });
    const wallet = await transaction.generationWallet.findUniqueOrThrow({
      where: { userId_creditType: { userId: input.userId, creditType: input.creditType } },
    });
    const existing = await transaction.creditLedgerEntry.findUnique({
      where: { walletId_operationKey: { walletId: wallet.id, operationKey } },
    });
    if (existing) {
      if (
        existing.kind !== 'REFUND' ||
        existing.units !== input.units ||
        existing.purchaseOrderId !== input.purchaseOrderId
      ) {
        throw new ApiHttpException(
          409,
          'CREDIT_OPERATION_KEY_REUSED',
          'Refund operation key was reused.',
        );
      }
      return;
    }
    const availableDebited = Math.min(wallet.available, input.units);
    const debtCreated = input.units - availableDebited;
    await transaction.generationWallet.update({
      where: { id: wallet.id },
      data: {
        available: { decrement: availableDebited },
        debt: { increment: debtCreated },
        version: { increment: 1 },
      },
    });
    await transaction.creditLedgerEntry.create({
      data: {
        walletId: wallet.id,
        kind: 'REFUND',
        units: input.units,
        operationKey,
        purchaseOrderId: input.purchaseOrderId,
        metadata: { providerRefundId: input.providerRefundId, availableDebited, debtCreated },
      },
    });
  }

  private async ensureWallet(
    transaction: Prisma.TransactionClient,
    userId: string,
    creditType: CreditType,
  ) {
    // Prisma's emulated upsert for a compound unique key can race at creation
    // and raise P2002. Use an explicit INSERT ON CONFLICT DO NOTHING instead.
    // SERIALIZABLE conflicts still retry the entire outer transaction.
    await transaction.generationWallet.createMany({
      data: [{ userId, creditType }],
      skipDuplicates: true,
    });
    return transaction.generationWallet.findUniqueOrThrow({
      where: { userId_creditType: { userId, creditType } },
    });
  }

  private async mutate(
    input: CreditMutation,
    action: 'reserve' | 'commit' | 'release',
    database?: Prisma.TransactionClient,
  ) {
    this.assertInput(input);
    const operation = async (transaction: Prisma.TransactionClient) => {
      const existing = await transaction.generationReservation.findUnique({
        where: { operationKey: input.operationKey },
        include: { wallet: true },
      });
      if (existing) return this.settleExisting(transaction, existing, input, action);

      if (action !== 'reserve') {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'CREDIT_RESERVATION_NOT_FOUND',
          'The credit reservation does not exist.',
        );
      }

      const wallet = await this.ensureWallet(transaction, input.userId, input.creditType);
      if ((wallet.debt ?? 0) > 0 || wallet.available < input.units) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          input.creditType === 'TEXT' ? 'INSUFFICIENT_TEXT_CREDITS' : 'INSUFFICIENT_IMAGE_CREDITS',
          'There are not enough prepaid generation credits.',
          { available: wallet.available, debt: wallet.debt ?? 0, required: input.units },
        );
      }

      const updated = await transaction.generationWallet.update({
        where: { id: wallet.id },
        data: {
          available: { decrement: input.units },
          reserved: { increment: input.units },
          version: { increment: 1 },
        },
      });
      const reservation = await transaction.generationReservation.create({
        data: {
          userId: input.userId,
          walletId: wallet.id,
          creditType: input.creditType,
          units: input.units,
          operationKey: input.operationKey,
          ...(input.publicationId ? { publicationId: input.publicationId } : {}),
          ...(input.aiRequestId ? { aiRequestId: input.aiRequestId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      await transaction.creditLedgerEntry.create({
        data: {
          walletId: wallet.id,
          kind: CreditLedgerKind.RESERVE,
          units: input.units,
          operationKey: `${input.operationKey}:reserve`,
          reservationId: reservation.id,
          ...(input.publicationId ? { publicationId: input.publicationId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      return this.balance(updated);
    };
    return database ? operation(database) : serializableTransaction(this.prisma, operation);
  }

  private async settleExisting(
    transaction: Prisma.TransactionClient,
    reservation: {
      id: string;
      userId: string;
      creditType: CreditType;
      units: number;
      status: ReservationStatus;
      publicationId?: string | null;
      wallet: {
        id: string;
        available: number;
        reserved: number;
        debt?: number;
        version: number;
        creditType: CreditType;
      };
    },
    input: CreditMutation,
    action: 'reserve' | 'commit' | 'release',
  ) {
    if (
      reservation.userId !== input.userId ||
      reservation.creditType !== input.creditType ||
      reservation.units !== input.units ||
      (input.publicationId !== undefined && reservation.publicationId !== input.publicationId)
    ) {
      throw new ApiHttpException(
        HttpStatus.CONFLICT,
        'CREDIT_OPERATION_KEY_REUSED',
        'The credit operation key was reused with different parameters.',
      );
    }
    if (action === 'reserve') {
      if (reservation.status === ReservationStatus.RELEASED) {
        throw new ApiHttpException(
          409,
          'CREDIT_RESERVATION_ALREADY_SETTLED',
          'The credit reservation has already been settled.',
        );
      }
      return this.balance(reservation.wallet);
    }

    const targetStatus =
      action === 'commit' ? ReservationStatus.COMMITTED : ReservationStatus.RELEASED;
    if (reservation.status === targetStatus) return this.balance(reservation.wallet);
    if (reservation.status !== ReservationStatus.RESERVED) {
      throw new ApiHttpException(
        HttpStatus.CONFLICT,
        'CREDIT_RESERVATION_ALREADY_SETTLED',
        'The credit reservation has already been settled.',
      );
    }

    const debtRepaid =
      action === 'release' ? Math.min(reservation.wallet.debt ?? 0, input.units) : 0;
    const wallet = await transaction.generationWallet.update({
      where: { id: reservation.wallet.id },
      data: {
        ...(action === 'release'
          ? { available: { increment: input.units - debtRepaid }, debt: { decrement: debtRepaid } }
          : {}),
        reserved: { decrement: input.units },
        version: { increment: 1 },
      },
    });
    await transaction.generationReservation.update({
      where: { id: reservation.id },
      data: { status: targetStatus, settledAt: new Date() },
    });
    await transaction.creditLedgerEntry.create({
      data: {
        walletId: wallet.id,
        kind: action === 'commit' ? CreditLedgerKind.COMMIT : CreditLedgerKind.RELEASE,
        units: input.units,
        operationKey: `${input.operationKey}:${action}`,
        reservationId: reservation.id,
        ...(reservation.publicationId ? { publicationId: reservation.publicationId } : {}),
      },
    });
    return this.balance(wallet);
  }

  private assertInput(input: Pick<CreditMutation, 'units' | 'operationKey'>): void {
    if (!Number.isSafeInteger(input.units) || input.units <= 0) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_CREDIT_AMOUNT',
        'Credit units must be a positive integer.',
      );
    }
    if (input.operationKey.length < 1 || input.operationKey.length > 255) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_CREDIT_OPERATION_KEY',
        'Credit operation key must contain 1 to 255 characters.',
      );
    }
  }

  private balance(wallet: {
    creditType: CreditType;
    available: number;
    reserved: number;
    debt?: number;
    version: number;
  }): WalletBalance {
    return {
      creditType: wallet.creditType,
      available: wallet.available,
      reserved: wallet.reserved,
      debt: wallet.debt ?? 0,
      version: wallet.version,
    };
  }
}
