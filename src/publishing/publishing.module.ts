import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { QueueModule } from '../infrastructure/queue/queue.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import {
  PublicationDispatcherService,
  PublicationProcessor,
} from './publishing-dispatcher.service.js';
import { PublishingController } from './publishing.controller.js';
import { PublishingService } from './publishing.service.js';
import {
  TelegramBotApiPublicationAdapter,
  TelegramPublicationAdapter,
} from './telegram-publication.adapter.js';

@Module({
  imports: [AuthModule, QueueModule, IdempotencyModule, SubscriptionsModule],
  controllers: [PublishingController],
  providers: [
    PublishingService,
    PublicationDispatcherService,
    PublicationProcessor,
    TelegramBotApiPublicationAdapter,
    { provide: TelegramPublicationAdapter, useExisting: TelegramBotApiPublicationAdapter },
  ],
})
export class PublishingModule {}
