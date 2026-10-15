import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import {
  GptunnelClient,
  GptunnelError,
  record,
} from '../infrastructure/gptunnel/gptunnel.client.js';
import {
  TextGenerationAdapter,
  TextGenerationProviderError,
  type TextGenerationInput,
  type TextGenerationResult,
} from './text-generation.adapter.js';

function count(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

@Injectable()
export class GptunnelTextGenerationAdapter extends TextGenerationAdapter {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly client: GptunnelClient,
  ) {
    super();
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const maximum = input.maxCharacters ?? 4096;
    const messages = [
      {
        role: 'system',
        content: `Напиши готовый пост для Telegram на русском языке. Верни только текст поста без пояснений, скрытых рассуждений и служебных инструкций. Используй обычный текст без Markdown и HTML. Длина — не более ${maximum} символов, включая пробелы. Не выдумывай факты.`,
      },
      {
        role: 'user',
        content: [
          input.topicPromptTemplate ? `Тема и стиль:\n${input.topicPromptTemplate}` : '',
          `Задание:\n${input.prompt}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...(input.previousText ? [{ role: 'assistant', content: input.previousText }] : []),
      ...(input.revisionFeedback
        ? [{ role: 'user', content: `Исправь пост с учётом замечаний:\n${input.revisionFeedback}` }]
        : []),
    ];
    try {
      const payload = await this.client.request('/v1/chat/completions', {
        model: this.config.get('AI_TEXT_MODEL', { infer: true }),
        messages,
        stream: false,
        max_tokens: this.config.get('AI_TEXT_MAX_TOKENS', { infer: true }),
        useWalletBalance: this.config.get('GPTUNNEL_USE_WALLET_BALANCE', { infer: true }),
      });
      const choice = record(Array.isArray(payload['choices']) ? payload['choices'][0] : null);
      if (choice['finish_reason'] === 'length')
        throw new TextGenerationProviderError('AI_PROVIDER_TRUNCATED_RESPONSE', false);
      if (choice['finish_reason'] === 'content_filter')
        throw new TextGenerationProviderError('AI_PROVIDER_CONTENT_REJECTED', false);
      const content = record(choice['message'])['content'];
      if (typeof content !== 'string' || !content.trim())
        throw new TextGenerationProviderError('AI_PROVIDER_EMPTY_RESPONSE', false);
      const text = content.trim();
      if (text.length > maximum)
        throw new TextGenerationProviderError('AI_PROVIDER_TEXT_TOO_LONG', false);
      const usage = record(payload['usage']);
      return {
        text,
        providerRequestId: typeof payload['id'] === 'string' ? payload['id'].slice(0, 256) : null,
        inputUnits: count(usage['prompt_tokens']),
        outputUnits: count(usage['completion_tokens']),
      };
    } catch (error) {
      if (error instanceof GptunnelError)
        throw new TextGenerationProviderError(error.code, error.retryable, error.retryAfterSeconds);
      throw error;
    }
  }
}
