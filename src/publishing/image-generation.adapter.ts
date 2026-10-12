import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import { ImageTempService } from '../infrastructure/image-temp/image-temp.service.js';

export type ImageGenerationInput = {
  prompt: string;
  text: string;
  idempotencyKey: string;
};

export type ImageGenerationResult = { filePath: string };

export class ImageGenerationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = 'ImageGenerationProviderError';
  }
}

export abstract class ImageGenerationAdapter {
  abstract generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

type OpenAiImageItem = { b64_json?: unknown; url?: unknown };
type OpenAiImageResponse = { data?: unknown };

@Injectable()
export class OpenAiImageGenerationAdapter extends ImageGenerationAdapter {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly temporaryImages: ImageTempService,
  ) {
    super();
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const apiKey = this.config.get('OPEN_API_KEY', { infer: true });
    if (!apiKey) throw new ImageGenerationProviderError('AI_PROVIDER_NOT_CONFIGURED', false);

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          model: this.config.get('AI_IMAGE_MODEL', { infer: true }),
          prompt: [
            'Create one safe, high-quality illustration for a Telegram post.',
            `Post request: ${input.prompt}`,
            `Post text: ${input.text}`,
          ].join('\n\n'),
          size: '1024x1024',
          output_format: 'png',
        }),
        signal: AbortSignal.timeout(this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true })),
      });
    } catch (error) {
      throw new ImageGenerationProviderError(
        'AI_IMAGE_PROVIDER_NETWORK_ERROR',
        true,
        error instanceof Error ? error.message : 'Image provider response was not received.',
      );
    }

    if (!response.ok) {
      throw new ImageGenerationProviderError(
        response.status === 429
          ? 'AI_IMAGE_PROVIDER_RATE_LIMITED'
          : `AI_IMAGE_PROVIDER_HTTP_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }

    let payload: OpenAiImageResponse;
    try {
      payload = (await response.json()) as OpenAiImageResponse;
    } catch {
      throw new ImageGenerationProviderError('AI_IMAGE_INVALID_RESPONSE', false);
    }
    const item = Array.isArray(payload.data)
      ? (payload.data[0] as OpenAiImageItem | undefined)
      : undefined;
    const bytes = await this.bytesFrom(item);
    try {
      return { filePath: await this.temporaryImages.createFile(bytes, '.png') };
    } catch (error) {
      throw new ImageGenerationProviderError(
        'AI_IMAGE_TEMP_STORAGE_UNAVAILABLE',
        true,
        error instanceof Error ? error.message : 'Temporary image storage is unavailable.',
      );
    }
  }

  private async bytesFrom(item: OpenAiImageItem | undefined): Promise<Uint8Array> {
    if (typeof item?.b64_json === 'string') {
      try {
        return Buffer.from(item.b64_json, 'base64');
      } catch {
        throw new ImageGenerationProviderError('AI_IMAGE_INVALID_RESPONSE', false);
      }
    }
    if (typeof item?.url === 'string') {
      try {
        const response = await fetch(item.url, {
          signal: AbortSignal.timeout(this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true })),
        });
        if (!response.ok) throw new Error(`image download returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new ImageGenerationProviderError(
          'AI_IMAGE_DOWNLOAD_FAILED',
          true,
          error instanceof Error ? error.message : 'Generated image could not be downloaded.',
        );
      }
    }
    throw new ImageGenerationProviderError('AI_IMAGE_EMPTY_RESPONSE', false);
  }
}
