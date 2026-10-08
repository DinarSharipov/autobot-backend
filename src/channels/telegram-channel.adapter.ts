import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';

export type ValidatedTelegramChannel = {
  telegramChatId: bigint;
  title: string;
  username: string | null;
  botPermissions: Record<string, boolean | string>;
};

export abstract class TelegramChannelAdapter {
  abstract validate(telegramChatId: bigint): Promise<ValidatedTelegramChannel>;
}

type TelegramResponse = { ok?: boolean; result?: unknown; description?: string };

@Injectable()
export class TelegramBotApiChannelAdapter extends TelegramChannelAdapter {
  private botIdPromise: Promise<bigint> | undefined;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  async validate(telegramChatId: bigint): Promise<ValidatedTelegramChannel> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (!token) {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TELEGRAM_CHANNEL_VALIDATION_NOT_CONFIGURED',
        'Telegram channel validation is not configured.',
      );
    }

    const chat = await this.call('getChat', { chat_id: telegramChatId.toString() }, token, true);
    const chatRecord = this.record(chat);
    if (chatRecord.type !== 'channel') {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TELEGRAM_CHAT_NOT_CHANNEL',
        'The Telegram chat is not a channel.',
      );
    }
    const botId = await this.botId(token);
    const member = this.record(
      await this.call(
        'getChatMember',
        { chat_id: telegramChatId.toString(), user_id: botId.toString() },
        token,
        true,
      ),
    );
    const status = typeof member.status === 'string' ? member.status : '';
    const canPost = member.can_post_messages === true || status === 'creator';
    if (!['administrator', 'creator'].includes(status) || !canPost) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TELEGRAM_BOT_CANNOT_POST',
        'The bot must be a channel administrator with permission to post messages.',
      );
    }

    const title = typeof chatRecord.title === 'string' ? chatRecord.title.trim() : '';
    if (!title) throw new Error('Telegram getChat returned no title');
    return {
      telegramChatId,
      title,
      username: typeof chatRecord.username === 'string' ? chatRecord.username : null,
      botPermissions: { status, canPostMessages: canPost },
    };
  }

  private async botId(token: string): Promise<bigint> {
    this.botIdPromise ??= this.call('getMe', {}, token, false).then((result) => {
      const id = this.record(result).id;
      if (typeof id !== 'number' && typeof id !== 'string') throw new Error('Invalid bot identity');
      return BigInt(id);
    });
    try {
      return await this.botIdPromise;
    } catch (error) {
      this.botIdPromise = undefined;
      throw error;
    }
  }

  private async call(
    method: string,
    body: Record<string, string>,
    token: string,
    domainFailure: boolean,
  ): Promise<unknown> {
    try {
      const response = await fetch(
        `${this.config.get('TELEGRAM_API_BASE_URL', { infer: true })}/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.get('TELEGRAM_API_TIMEOUT_MS', { infer: true })),
        },
      );
      const payload = (await response.json()) as TelegramResponse;
      if (!response.ok || payload.ok !== true) {
        if (domainFailure && response.status >= 400 && response.status < 500) {
          throw new ApiHttpException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'TELEGRAM_CHANNEL_UNAVAILABLE',
            'The channel is unavailable to the bot.',
          );
        }
        throw new Error(`Telegram API request failed with status ${response.status}`);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof ApiHttpException) throw error;
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TELEGRAM_API_UNAVAILABLE',
        'Telegram is temporarily unavailable.',
      );
    }
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TELEGRAM_API_INVALID_RESPONSE',
        'Telegram returned an invalid response.',
      );
    }
    return value as Record<string, unknown>;
  }
}
