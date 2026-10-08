import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import {
  TelegramBotApiChannelAdapter,
  TelegramChannelAdapter,
} from './telegram-channel.adapter.js';

@Module({
  imports: [AuthModule, SubscriptionsModule],
  controllers: [ChannelsController],
  providers: [
    ChannelsService,
    { provide: TelegramChannelAdapter, useClass: TelegramBotApiChannelAdapter },
  ],
  exports: [ChannelsService, TelegramChannelAdapter],
})
export class ChannelsModule {}
