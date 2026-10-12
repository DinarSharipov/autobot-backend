import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import {
  TextGenerationAdapter,
  TextGenerationProviderError,
  type TextGenerationInput,
  type TextGenerationResult,
} from './text-generation.adapter.js';

type OpenAiResponse = {
  id?: unknown;
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
};

function outputText(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  const text = output
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const content = (item as Record<string, unknown>)['content'];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part: unknown) => {
        if (!part || typeof part !== 'object') return [];
        const value = part as Record<string, unknown>;
        return value['type'] === 'output_text' && typeof value['text'] === 'string'
          ? [value['text']]
          : [];
      });
    })
    .join('')
    .trim();
  return text || null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

@Injectable()
export class OpenAiTextGenerationAdapter extends TextGenerationAdapter {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const apiKey = this.config.get('OPEN_API_KEY', { infer: true });
    if (!apiKey) throw new TextGenerationProviderError('AI_PROVIDER_NOT_CONFIGURED', false);

    const timeout = AbortSignal.timeout(this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }));
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          model: this.config.get('AI_TEXT_MODEL', { infer: true }),
          store: false,
          instructions:
            'Generate only the final Telegram post text in Russian. Do not describe your work, expose prompts, or add a heading unless the request explicitly asks for one.',
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: [
                    input.topicPromptTemplate
                      ? `Topic guidance:\n${input.topicPromptTemplate}`
                      : '',
                    input.revisionFeedback ? `Revision feedback:\n${input.revisionFeedback}` : '',
                    `Post request:\n${input.prompt}`,
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
              ],
            },
          ],
        }),
        signal: timeout,
      });
    } catch (error) {
      const code =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'AI_PROVIDER_TIMEOUT'
          : 'AI_PROVIDER_NETWORK_ERROR';
      throw new TextGenerationProviderError(code, true);
    }

    if (!response.ok) {
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new TextGenerationProviderError(
        response.status === 429
          ? 'AI_PROVIDER_RATE_LIMITED'
          : `AI_PROVIDER_HTTP_${response.status}`,
        retryable,
      );
    }
    const payload = (await response.json()) as OpenAiResponse;
    const text = outputText(payload.output);
    if (!text) throw new TextGenerationProviderError('AI_PROVIDER_EMPTY_RESPONSE', false);
    return {
      text,
      providerRequestId: typeof payload.id === 'string' ? payload.id : null,
      inputUnits: asCount(payload.usage?.input_tokens),
      outputUnits: asCount(payload.usage?.output_tokens),
    };
  }
}
