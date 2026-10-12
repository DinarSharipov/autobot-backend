import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';

export type TelegramPublicationResult = {
  chatId: bigint;
  messageId: bigint;
};

export class TelegramPublicationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
    readonly retryAfterSeconds?: number,
    message = code,
  ) {
    super(message);
    this.name = 'TelegramPublicationError';
  }
}

export abstract class TelegramPublicationAdapter {
  abstract sendText(chatId: bigint, text: string): Promise<TelegramPublicationResult>;
  abstract sendPhoto(
    chatId: bigint,
    caption: string,
    filePath: string,
  ): Promise<TelegramPublicationResult>;
}

type TelegramMessage = { message_id?: unknown; chat?: { id?: unknown } };
type TelegramPayload = {
  ok?: boolean;
  result?: TelegramMessage;
  description?: string;
  parameters?: { retry_after?: unknown };
};

@Injectable()
export class TelegramBotApiPublicationAdapter extends TelegramPublicationAdapter {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  async sendText(chatId: bigint, text: string): Promise<TelegramPublicationResult> {
    if (!text.trim()) {
      throw new TelegramPublicationError(
        'PUBLICATION_TEXT_EMPTY',
        false,
        false,
        undefined,
        'Publication text is empty.',
      );
    }
    if (text.length > 4096) {
      throw new TelegramPublicationError(
        'PUBLICATION_TEXT_TOO_LONG',
        false,
        false,
        undefined,
        'Telegram text exceeds the 4096 character limit.',
      );
    }

    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (!token) {
      throw new TelegramPublicationError(
        'TELEGRAM_NOT_CONFIGURED',
        true,
        false,
        undefined,
        'Telegram bot token is not configured.',
      );
    }

    const response = await this.request('sendMessage', { chat_id: chatId.toString(), text });
    return this.result(response);
  }

  async sendPhoto(
    chatId: bigint,
    caption: string,
    filePath: string,
  ): Promise<TelegramPublicationResult> {
    if (!caption.trim()) {
      throw new TelegramPublicationError(
        'PUBLICATION_TEXT_EMPTY',
        false,
        false,
        undefined,
        'Publication caption is empty.',
      );
    }
    if (caption.length > 1024) {
      throw new TelegramPublicationError(
        'PUBLICATION_CAPTION_TOO_LONG',
        false,
        false,
        undefined,
        'Telegram photo caption exceeds the 1024 character limit.',
      );
    }

    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (!token) {
      throw new TelegramPublicationError(
        'TELEGRAM_NOT_CONFIGURED',
        true,
        false,
        undefined,
        'Telegram bot token is not configured.',
      );
    }

    let response: Response;
    try {
      const form = new FormData();
      form.set('chat_id', chatId.toString());
      form.set('caption', caption);
      let bytes: Buffer;
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        throw new TelegramPublicationError(
          'PUBLICATION_IMAGE_UNAVAILABLE',
          true,
          false,
          undefined,
          error instanceof Error ? error.message : 'Temporary image file is unavailable.',
        );
      }
      form.set('photo', new Blob([bytes], { type: 'image/png' }), basename(filePath));
      response = await fetch(
        `${this.config.get('TELEGRAM_API_BASE_URL', { infer: true })}/bot${token}/sendPhoto`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(this.config.get('TELEGRAM_API_TIMEOUT_MS', { infer: true })),
        },
      );
    } catch (error) {
      if (error instanceof TelegramPublicationError) throw error;
      throw new TelegramPublicationError(
        'TELEGRAM_DELIVERY_UNKNOWN',
        false,
        true,
        undefined,
        error instanceof Error ? error.message : 'Telegram response was not received.',
      );
    }
    return this.result(response);
  }

  private async request(method: 'sendMessage', body: Record<string, string>): Promise<Response> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (!token) {
      throw new TelegramPublicationError(
        'TELEGRAM_NOT_CONFIGURED',
        true,
        false,
        undefined,
        'Telegram bot token is not configured.',
      );
    }
    try {
      return await fetch(
        `${this.config.get('TELEGRAM_API_BASE_URL', { infer: true })}/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.get('TELEGRAM_API_TIMEOUT_MS', { infer: true })),
        },
      );
    } catch (error) {
      throw new TelegramPublicationError(
        'TELEGRAM_DELIVERY_UNKNOWN',
        false,
        true,
        undefined,
        error instanceof Error ? error.message : 'Telegram response was not received.',
      );
    }
  }

  private async result(response: Response): Promise<TelegramPublicationResult> {
    let payload: TelegramPayload;
    try {
      payload = (await response.json()) as TelegramPayload;
    } catch (error) {
      throw new TelegramPublicationError(
        'TELEGRAM_DELIVERY_UNKNOWN',
        false,
        true,
        undefined,
        error instanceof Error ? error.message : 'Telegram returned invalid JSON.',
      );
    }

    if (!response.ok || payload.ok !== true) {
      const retryAfter = this.retryAfter(payload.parameters?.retry_after);
      if (response.status === 429) {
        throw new TelegramPublicationError(
          'TELEGRAM_RATE_LIMIT',
          true,
          false,
          retryAfter,
          payload.description ?? 'Telegram rate limit exceeded.',
        );
      }
      if (response.status >= 500 || response.status === 408) {
        throw new TelegramPublicationError(
          'TELEGRAM_API_UNAVAILABLE',
          true,
          false,
          retryAfter,
          payload.description ?? 'Telegram is temporarily unavailable.',
        );
      }
      throw new TelegramPublicationError(
        'TELEGRAM_PUBLICATION_REJECTED',
        false,
        false,
        undefined,
        payload.description ?? `Telegram rejected the publication (${response.status}).`,
      );
    }

    const messageId = this.numericId(payload.result?.message_id);
    const returnedChatId = this.numericId(payload.result?.chat?.id);
    if (messageId === null || returnedChatId === null) {
      throw new TelegramPublicationError(
        'TELEGRAM_INVALID_RESPONSE',
        false,
        true,
        undefined,
        'Telegram returned no message identifier.',
      );
    }
    return { chatId: returnedChatId, messageId };
  }

  private retryAfter(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private numericId(value: unknown): bigint | null {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
}
