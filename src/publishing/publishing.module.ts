import { Module } from '@nestjs/common';

import { PublicationMediaModule } from './publication-media.module.js';
import { GptunnelModule } from '../infrastructure/gptunnel/gptunnel.module.js';

import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { QueueModule } from '../infrastructure/queue/queue.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationPacksModule } from '../generation-packs/generation-packs.module.js';
import {
  PublicationDispatcherService,
  PublicationProcessor,
} from './publishing-dispatcher.service.js';
import { PublishingController } from './publishing.controller.js';
import { PublishingService } from './publishing.service.js';

@Module({
  imports: [
    AuthModule,
    QueueModule,
    IdempotencyModule,
    SubscriptionsModule,
    GenerationPacksModule,
    GptunnelModule,
    PublicationMediaModule,
  ],
  controllers: [PublishingController],
  providers: [PublishingService, PublicationDispatcherService, PublicationProcessor],
})
export class PublishingModule {}
