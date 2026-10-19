import { HttpStatus, Injectable } from '@nestjs/common';

import { RevisionAllowanceOperationStatus, type Prisma } from '../generated/prisma/client.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';

@Injectable()
export class RevisionAllowanceService {
  constructor(private readonly prisma: PrismaService) {}

  ensure(userId: string, publicationId: string, database?: Prisma.TransactionClient) {
    const operation = (transaction: Prisma.TransactionClient) =>
      transaction.textRevisionAllowance.upsert({
        where: { publicationId },
        create: { userId, publicationId },
        update: {},
      });
    return database ? operation(database) : serializableTransaction(this.prisma, operation);
  }

  reserve(
    userId: string,
    publicationId: string,
    operationKey: string,
    database?: Prisma.TransactionClient,
  ) {
    return this.mutate(userId, publicationId, operationKey, 'reserve', database);
  }

  commit(operationKey: string, database?: Prisma.TransactionClient) {
    return this.settle(operationKey, 'commit', database);
  }

  release(operationKey: string, database?: Prisma.TransactionClient) {
    return this.settle(operationKey, 'release', database);
  }

  private async mutate(
    userId: string,
    publicationId: string,
    operationKey: string,
    action: 'reserve',
    database?: Prisma.TransactionClient,
  ) {
    const operation = async (transaction: Prisma.TransactionClient) => {
      const allowance = await transaction.textRevisionAllowance.upsert({
        where: { publicationId },
        create: { userId, publicationId },
        update: {},
      });
      const existing = await transaction.textRevisionAllowanceOperation.findUnique({
        where: { operationKey },
      });
      if (existing) {
        if (existing.allowanceId !== allowance.id) this.reusedKey();
        if (existing.status === RevisionAllowanceOperationStatus.RELEASED) this.reusedKey();
        return allowance;
      }
      const updated = await transaction.textRevisionAllowance.updateMany({
        where: {
          id: allowance.id,
          includedCommitted: { lt: allowance.includedTotal },
          // The predicate is evaluated with the row lock acquired by UPDATE,
          // preventing two callers from consuming the last included revision.
          includedReserved: { lt: allowance.includedTotal },
        },
        data: { includedReserved: { increment: 1 }, version: { increment: 1 } },
      });
      if (!updated.count) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'REVISION_ALLOWANCE_EXHAUSTED',
          'Included text revisions are exhausted; paid revision confirmation is required.',
        );
      }
      const current = await transaction.textRevisionAllowance.findUniqueOrThrow({
        where: { id: allowance.id },
      });
      if (current.includedCommitted + current.includedReserved > current.includedTotal) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'REVISION_ALLOWANCE_EXHAUSTED',
          'Included text revisions are exhausted; paid revision confirmation is required.',
        );
      }
      await transaction.textRevisionAllowanceOperation.create({
        data: {
          allowanceId: allowance.id,
          operationKey,
          status: RevisionAllowanceOperationStatus.RESERVED,
        },
      });
      return allowance;
    };
    return database ? operation(database) : serializableTransaction(this.prisma, operation);
  }

  private async settle(
    operationKey: string,
    action: 'commit' | 'release',
    database?: Prisma.TransactionClient,
  ) {
    const operation = async (transaction: Prisma.TransactionClient) => {
      const reservation = await transaction.textRevisionAllowanceOperation.findUnique({
        where: { operationKey },
      });
      if (!reservation) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'REVISION_ALLOWANCE_RESERVATION_NOT_FOUND',
          'The included revision reservation does not exist.',
        );
      }
      const target =
        action === 'commit'
          ? RevisionAllowanceOperationStatus.COMMITTED
          : RevisionAllowanceOperationStatus.RELEASED;
      if (reservation.status === target) {
        return transaction.textRevisionAllowance.findUniqueOrThrow({
          where: { id: reservation.allowanceId },
        });
      }
      if (reservation.status !== RevisionAllowanceOperationStatus.RESERVED) {
        throw new ApiHttpException(
          HttpStatus.CONFLICT,
          'REVISION_ALLOWANCE_ALREADY_SETTLED',
          'The included revision reservation has already been settled.',
        );
      }
      const allowance = await transaction.textRevisionAllowance.update({
        where: { id: reservation.allowanceId },
        data: {
          includedReserved: { decrement: 1 },
          ...(action === 'commit' ? { includedCommitted: { increment: 1 } } : {}),
          version: { increment: 1 },
        },
      });
      await transaction.textRevisionAllowanceOperation.update({
        where: { operationKey },
        data: { status: target, settledAt: new Date() },
      });
      return allowance;
    };
    return database ? operation(database) : serializableTransaction(this.prisma, operation);
  }

  private reusedKey(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'REVISION_ALLOWANCE_OPERATION_KEY_REUSED',
      'The revision allowance operation key was reused with different parameters.',
    );
  }
}
