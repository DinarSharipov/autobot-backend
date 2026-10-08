import type { PrismaClient } from '../../src/generated/prisma/client.js';

export function assertIsolatedTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.slice(1);

  if (!databaseName.endsWith('_test')) {
    throw new Error('Refusing to clean a database whose name does not end with _test.');
  }
}

export async function cleanTestDatabase(prisma: PrismaClient, databaseUrl: string): Promise<void> {
  assertIsolatedTestDatabase(databaseUrl);

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditEvent",
      "OutboxEvent",
      "UsageLedgerEntry",
      "UsageCounter",
      "IdempotencyRecord",
      "AIRequest",
      "Subscription",
      "SubscriptionPlan",
      "ModerationRequest",
      "PostVersion",
      "Publication",
      "PostSchedule",
      "Post",
      "Topic",
      "Channel",
      "Session",
      "AuthIdentity",
      "TelegramAccount",
      "User"
    RESTART IDENTITY CASCADE
  `);
}
