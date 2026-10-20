import { setTimeout as delay } from 'node:timers/promises';

import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

const MAX_ATTEMPTS = 6;

function isSerializationConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const candidate = error as { code?: unknown; originalCode?: unknown; cause?: unknown };
  // Prisma normalizes query conflicts to P2034, but the pg adapter can expose
  // SQLSTATE directly when the conflict occurs while COMMIT is executing.
  if (
    [candidate.code, candidate.originalCode].some(
      (code) => code === 'P2034' || code === '40001' || code === '40P01',
    )
  )
    return true;
  return isSerializationConflict(candidate.cause, depth + 1);
}

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
      const retryable = isSerializationConflict(error);
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      await delay(attempt * 10);
    }
  }

  throw new Error('Serializable transaction retry loop exhausted');
}
