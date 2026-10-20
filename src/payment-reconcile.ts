import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { validateEnvironment } from './config/environment.js';
import { IdempotencyModule } from './common/idempotency/idempotency.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RefundsService } from './generation-packs/refunds.service.js';
import { PaymentsService } from './generation-packs/payments.service.js';
import { PurchaseService } from './generation-packs/purchase.service.js';
import { WalletService } from './generation-packs/wallet.service.js';
import { YooKassaAdapter } from './generation-packs/yookassa.adapter.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    PrismaModule,
    IdempotencyModule,
  ],
  providers: [PaymentsService, PurchaseService, WalletService, YooKassaAdapter, RefundsService],
})
class PaymentReconciliationModule {}

try {
  const app = await NestFactory.createApplicationContext(PaymentReconciliationModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const result = await app.get(PaymentsService).reconcile();
    const refunds = await app.get(RefundsService).reconcile();
    console.log(JSON.stringify({ ...result, refunds }));
    if (result.failed || refunds.failed) process.exitCode = 1;
  } finally {
    await app.close();
  }
} catch {
  console.error('Payment reconciliation failed; no payment credentials or payloads are logged.');
  process.exitCode = 1;
}
