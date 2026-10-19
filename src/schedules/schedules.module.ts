import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationPacksModule } from '../generation-packs/generation-packs.module.js';
import { SchedulerService } from './scheduler.service.js';
import { SchedulesController } from './schedules.controller.js';
import { SchedulesService } from './schedules.service.js';

@Module({
  imports: [AuthModule, IdempotencyModule, SubscriptionsModule, GenerationPacksModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
