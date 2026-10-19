import { Module } from '@nestjs/common';

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
import { GptunnelImageGenerationAdapter } from './gptunnel-image-generation.adapter.js';
import { PublishingController } from './publishing.controller.js';
import { PublishingService } from './publishing.service.js';
import {
  TelegramBotApiPublicationAdapter,
  TelegramPublicationAdapter,
} from './telegram-publication.adapter.js';
import { ImageGenerationAdapter } from './image-generation.adapter.js';

@Module({
  imports: [
    AuthModule,
    QueueModule,
    IdempotencyModule,
    SubscriptionsModule,
    GenerationPacksModule,
    GptunnelModule,
  ],
  controllers: [PublishingController],
  providers: [
    PublishingService,
    PublicationDispatcherService,
    PublicationProcessor,
    TelegramBotApiPublicationAdapter,
    { provide: TelegramPublicationAdapter, useExisting: TelegramBotApiPublicationAdapter },
    GptunnelImageGenerationAdapter,
    { provide: ImageGenerationAdapter, useExisting: GptunnelImageGenerationAdapter },
  ],
})
export class PublishingModule {}
