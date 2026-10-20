import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationPacksController } from './generation-packs.controller.js';
import { PurchaseService } from './purchase.service.js';
import { WalletService } from './wallet.service.js';
import { GenerationFundingService } from './generation-funding.service.js';
import { RevisionAllowanceService } from './revision-allowance.service.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController, YooKassaWebhookController } from './payments.controller.js';
import { YooKassaAdapter } from './yookassa.adapter.js';

@Module({
  imports: [AuthModule, IdempotencyModule, SubscriptionsModule],
  controllers: [
    GenerationPacksController,
    PaymentsController,
    YooKassaWebhookController,
    RefundsController,
  ],
  providers: [
    PurchaseService,
    WalletService,
    RevisionAllowanceService,
    GenerationFundingService,
    YooKassaAdapter,
    PaymentsService,
    RefundsService,
  ],
  exports: [PurchaseService, WalletService, RevisionAllowanceService, GenerationFundingService],
})
export class GenerationPacksModule {}
