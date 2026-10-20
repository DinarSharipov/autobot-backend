import { setTimeout as delay } from 'node:timers/promises';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import {
  GptunnelClient,
  GptunnelError,
  readBounded,
  record,
} from '../infrastructure/gptunnel/gptunnel.client.js';
import { ImageTempService } from '../infrastructure/image-temp/image-temp.service.js';
import {
  ImageGenerationAdapter,
  ImageGenerationProviderError,
  type ImageGenerationInput,
  type ImageGenerationResult,
} from './image-generation.adapter.js';

function extension(bytes: Uint8Array): string {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return '.jpg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
    return '.webp';
  throw new GptunnelError('AI_IMAGE_INVALID_FORMAT', false);
}

function isPublicDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd'))
    return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

@Injectable()
export class GptunnelImageGenerationAdapter extends ImageGenerationAdapter {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly temporaryImages: ImageTempService,
    private readonly client: GptunnelClient,
  ) {
    super();
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const signal = AbortSignal.timeout(this.config.get('AI_IMAGE_TIMEOUT_MS', { infer: true }));
    try {
      const model = this.config.get('AI_IMAGE_MODEL', { infer: true });
      // The authenticated catalogue is authoritative; never guess OpenAI image parameters.
      const catalogue = await this.client.request(
        '/api/v2/media/models?type=IMAGE',
        undefined,
        signal,
      );
      const selected = Array.isArray(catalogue['models'])
        ? catalogue['models']
            .map(record)
            .find((item) => item['id'] === model && item['type'] === 'IMAGE')
        : undefined;
      if (!selected) throw new GptunnelError('AI_IMAGE_MODEL_UNAVAILABLE', false);
      if (
        Array.isArray(selected['inputs']) &&
        selected['inputs'].some((item) => record(item)['required'] === true)
      )
        throw new GptunnelError('AI_IMAGE_MODEL_REQUIRES_INPUT', false);

      let task = await this.client.request(
        '/api/v2/media/tasks',
        {
          model,
          prompt: [
            'Создай одну иллюстрацию к посту для Telegram. Без надписей, водяных знаков и логотипов.',
            `Задание: ${input.prompt}`,
            `Текст поста: ${input.text}`,
          ].join('\n\n'),
          params: this.config.get('GPTUNNEL_IMAGE_PARAMS', { infer: true }),
          idempotency_key: input.idempotencyKey,
          wait: false,
        },
        signal,
      );
      const taskId = task['id'];
      if (typeof taskId !== 'string' || !/^[a-f\d]{24}$/i.test(taskId))
        throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
      for (;;) {
        if (task['id'] !== taskId) throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
        if (task['status'] === 'failed') {
          const code = record(task['error'])['code'];
          // Repeating a failed task's key returns the same failure; do not create paid replacements.
          const safeCode =
            typeof code === 'number' && Number.isSafeInteger(code) ? code : 'UNKNOWN';
          throw new GptunnelError(`AI_IMAGE_TASK_FAILED_${safeCode}`, false);
        }
        if (task['status'] === 'done') break;
        if (task['status'] !== 'queued' && task['status'] !== 'running')
          throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
        await delay(this.config.get('AI_IMAGE_POLL_INTERVAL_MS', { infer: true }), undefined, {
          signal,
        });
        task = await this.client.request(`/api/v2/media/tasks/${taskId}`, undefined, signal);
      }
      const first = Array.isArray(task['result']) ? record(task['result'][0]) : {};
      const url = first['url'];
      if (typeof url !== 'string') throw new GptunnelError('AI_IMAGE_EMPTY_RESPONSE', false);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
        throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
      if (!isPublicDownloadHost(parsed.hostname))
        throw new GptunnelError('AI_IMAGE_INVALID_RESPONSE', false);
      const bytes = await this.download(parsed, signal);
      const suffix = extension(bytes);
      try {
        return {
          filePath: await this.temporaryImages.createFile(bytes, suffix),
          providerRequestId: taskId,
        };
      } catch {
        throw new GptunnelError('AI_IMAGE_TEMP_STORAGE_UNAVAILABLE', true);
      }
    } catch (error) {
      if (error instanceof GptunnelError)
        throw new ImageGenerationProviderError(
          error.code,
          error.retryable,
          error.retryAfterSeconds,
        );
      throw new ImageGenerationProviderError(
        signal.aborted ? 'AI_IMAGE_PROVIDER_TIMEOUT' : 'AI_IMAGE_PROVIDER_NETWORK_ERROR',
        true,
      );
    }
  }

  private async download(url: URL, signal: AbortSignal): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }));
    try {
      // Never send the GPTunnel key to image storage, including through redirects.
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      });
      if (!response.ok)
        throw new GptunnelError(
          'AI_IMAGE_DOWNLOAD_FAILED',
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      return await readBounded(response, this.config.get('IMAGE_MAX_BYTES', { infer: true }));
    } catch (error) {
      if (error instanceof GptunnelError) throw error;
      throw new GptunnelError('AI_IMAGE_DOWNLOAD_FAILED', true);
    }
  }
}
