import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { GenerationPacksModule } from '../generation-packs/generation-packs.module.js';
import { GptunnelModule } from '../infrastructure/gptunnel/gptunnel.module.js';
import { QueueModule } from '../infrastructure/queue/queue.module.js';
import { ImageGenerationAdapter } from './image-generation.adapter.js';
import { GptunnelImageGenerationAdapter } from './gptunnel-image-generation.adapter.js';
import {
  TelegramPublicationAdapter,
  TelegramBotApiPublicationAdapter,
} from './telegram-publication.adapter.js';
import { PublicationMediaController } from './publication-media.controller.js';
import { PublicationMediaService } from './publication-media.service.js';
import {
  PublicationMediaDispatcher,
  PublicationMediaProcessor,
} from './publication-media-dispatcher.service.js';
@Module({
  imports: [AuthModule, IdempotencyModule, GenerationPacksModule, GptunnelModule, QueueModule],
  controllers: [PublicationMediaController],
  providers: [
    PublicationMediaService,
    PublicationMediaDispatcher,
    PublicationMediaProcessor,
    GptunnelImageGenerationAdapter,
    { provide: ImageGenerationAdapter, useExisting: GptunnelImageGenerationAdapter },
    TelegramBotApiPublicationAdapter,
    { provide: TelegramPublicationAdapter, useExisting: TelegramBotApiPublicationAdapter },
  ],
  exports: [PublicationMediaService, ImageGenerationAdapter, TelegramPublicationAdapter],
})
export class PublicationMediaModule {}
