import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationPacksModule } from '../generation-packs/generation-packs.module.js';
import { ModerationController } from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';

@Module({
  imports: [AuthModule, IdempotencyModule, SubscriptionsModule, GenerationPacksModule],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
