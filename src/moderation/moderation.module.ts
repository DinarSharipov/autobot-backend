import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { ModerationController } from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';

@Module({
  imports: [AuthModule, IdempotencyModule, SubscriptionsModule],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
