import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';

import type { AppEnvironment } from '../../config/environment.js';
import { QUEUE_NAMES } from './queue.constants.js';

function connectionFromUrl(value: string): ConnectionOptions {
  const url = new URL(value);
  const database = url.pathname.length > 1 ? Number.parseInt(url.pathname.slice(1), 10) : 0;

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    db: Number.isNaN(database) ? 0 : database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 5000,
    maxRetriesPerRequest: null,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) => ({
        connection: connectionFromUrl(config.get('REDIS_URL', { infer: true })),
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.postGeneration },
      { name: QUEUE_NAMES.publication },
      { name: QUEUE_NAMES.scheduling },
      { name: QUEUE_NAMES.outbox },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
