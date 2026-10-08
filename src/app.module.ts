import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './common/auth/authorization.module.js';
import { IdempotencyModule } from './common/idempotency/idempotency.module.js';
import { ApiExceptionFilter } from './common/http/api-exception.filter.js';
import { RequestLoggingInterceptor } from './common/http/request-logging.interceptor.js';
import { validateEnvironment } from './config/environment.js';
import { HealthModule } from './health/health.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { ImageTempModule } from './infrastructure/image-temp/image-temp.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { TopicsModule } from './topics/topics.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    AuthorizationModule,
    IdempotencyModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    ImageTempModule,
    AuthModule,
    SubscriptionsModule,
    ChannelsModule,
    TopicsModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
