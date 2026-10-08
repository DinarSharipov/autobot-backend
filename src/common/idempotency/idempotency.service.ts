import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { serializableTransaction } from '../database/serializable-transaction.js';
import { ApiHttpException } from '../http/api-http.exception.js';

const RETENTION_MS = 25 * 60 * 60 * 1000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  digest(payload: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(stableValue(payload)))
      .digest('hex');
  }

  async replay<T>(input: {
    userId: string;
    operation: string;
    key: string;
    requestHash: string;
  }): Promise<T | null> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_operation_key: {
          userId: input.userId,
          operation: input.operation,
          key: input.key,
        },
      },
    });
    if (!existing) return null;
    if (existing.requestHash !== input.requestHash) {
      throw new ApiHttpException(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_KEY_REUSED',
        'The idempotency key was already used with a different request.',
      );
    }
    return existing.responseBody as T;
  }

  async execute<T>(input: {
    userId: string;
    operation: string;
    key: string;
    requestHash: string;
    handler: (transaction: Prisma.TransactionClient) => Promise<T>;
  }): Promise<T> {
    try {
      return await serializableTransaction(this.prisma, async (transaction) => {
        const existing = await transaction.idempotencyRecord.findUnique({
          where: {
            userId_operation_key: {
              userId: input.userId,
              operation: input.operation,
              key: input.key,
            },
          },
        });

        if (existing) {
          if (existing.requestHash !== input.requestHash) {
            throw new ApiHttpException(
              HttpStatus.CONFLICT,
              'IDEMPOTENCY_KEY_REUSED',
              'The idempotency key was already used with a different request.',
            );
          }
          return existing.responseBody as T;
        }

        const result = await input.handler(transaction);
        await transaction.idempotencyRecord.create({
          data: {
            userId: input.userId,
            operation: input.operation,
            key: input.key,
            requestHash: input.requestHash,
            responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + RETENTION_MS),
          },
        });
        return result;
      });
    } catch (error) {
      const uniqueConflict =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
      if (uniqueConflict) {
        const replay = await this.replay<T>(input);
        if (replay) return replay;
      }
      throw error;
    }
  }
}
