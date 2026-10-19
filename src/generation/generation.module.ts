import { Module } from '@nestjs/common';

import { GptunnelModule } from '../infrastructure/gptunnel/gptunnel.module.js';

import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationPacksModule } from '../generation-packs/generation-packs.module.js';
import { GenerationService } from './generation.service.js';
import { GptunnelTextGenerationAdapter } from './gptunnel-text-generation.adapter.js';
import { OutboxDispatcherService, PostGenerationProcessor } from './outbox-dispatcher.service.js';
import { TextGenerationAdapter } from './text-generation.adapter.js';

@Module({
  imports: [SubscriptionsModule, GenerationPacksModule, GptunnelModule],
  providers: [
    GenerationService,
    GptunnelTextGenerationAdapter,
    { provide: TextGenerationAdapter, useExisting: GptunnelTextGenerationAdapter },
    OutboxDispatcherService,
    PostGenerationProcessor,
  ],
})
export class GenerationModule {}
