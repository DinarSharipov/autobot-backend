import type { TestingModuleBuilder } from '@nestjs/testing';

import {
  OutboxDispatcherService,
  PostGenerationProcessor,
} from '../../src/generation/outbox-dispatcher.service.js';
import {
  PublicationDispatcherService,
  PublicationProcessor,
} from '../../src/publishing/publishing-dispatcher.service.js';
import { SchedulerService } from '../../src/schedules/scheduler.service.js';

// These suites drive services explicitly. Background consumers would race their
// assertions and database cleanup. The pipeline suite keeps real BullMQ workers.
export function withoutBackgroundJobs(builder: TestingModuleBuilder): TestingModuleBuilder {
  for (const provider of [
    SchedulerService,
    OutboxDispatcherService,
    PublicationDispatcherService,
    PostGenerationProcessor,
    PublicationProcessor,
  ]) {
    builder.overrideProvider(provider).useValue({});
  }
  return builder;
}
