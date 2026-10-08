import { setTimeout as delay } from 'node:timers/promises';

import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

const MAX_ATTEMPTS = 6;

export async function serializableTransaction<T>(
  prisma: PrismaService,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: 'Serializable',
      });
    } catch (error) {
      const retryable =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034';
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      await delay(attempt * 10);
    }
  }

  throw new Error('Serializable transaction retry loop exhausted');
}
