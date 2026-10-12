import { Module } from '@nestjs/common';

import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { GenerationService } from './generation.service.js';
import { OpenAiTextGenerationAdapter } from './openai-text-generation.adapter.js';
import { OutboxDispatcherService, PostGenerationProcessor } from './outbox-dispatcher.service.js';
import { TextGenerationAdapter } from './text-generation.adapter.js';

@Module({
  imports: [SubscriptionsModule],
  providers: [
    GenerationService,
    OpenAiTextGenerationAdapter,
    { provide: TextGenerationAdapter, useExisting: OpenAiTextGenerationAdapter },
    OutboxDispatcherService,
    PostGenerationProcessor,
  ],
})
export class GenerationModule {}
