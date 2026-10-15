import type { ReadableStreamDefaultReader } from 'node:stream/web';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';

export class GptunnelError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    // Never propagate provider messages: they can contain prompts, URLs or credentials.
    super(code);
  }
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function providerFailure(status: number, payload: unknown, retryAfter?: string | null) {
  const code = record(payload)['code'];
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const delay = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
  if (code === 6) return new GptunnelError('AI_PROVIDER_KEY_LIMIT_EXCEEDED', false);
  if (status === 401) return new GptunnelError('AI_PROVIDER_UNAUTHORIZED', false);
  if (status === 402 || code === 5)
    return new GptunnelError('AI_PROVIDER_INSUFFICIENT_BALANCE', false);
  if (status === 403) return new GptunnelError('AI_PROVIDER_FORBIDDEN', false);
  if (status === 429) return new GptunnelError('AI_PROVIDER_RATE_LIMITED', true, delay);
  return new GptunnelError(`AI_PROVIDER_HTTP_${status}`, status === 408 || status >= 500, delay);
}

export async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new GptunnelError('AI_PROVIDER_RESPONSE_TOO_LARGE', false);
  }
  if (!response.body) throw new GptunnelError('AI_PROVIDER_INVALID_RESPONSE', false);
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new GptunnelError('AI_PROVIDER_RESPONSE_TOO_LARGE', false);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

@Injectable()
export class GptunnelClient {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const apiKey = this.config.get('GPTUNNEL_API_KEY', { infer: true });
    if (!apiKey) throw new GptunnelError('AI_PROVIDER_NOT_CONFIGURED', false);
    const timeout = AbortSignal.timeout(this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }));
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const response = await fetch(`https://gptunnel.ru${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
        redirect: 'error',
      });
      const bytes = await readBounded(response, 1024 * 1024);
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      } catch {
        if (!response.ok)
          throw providerFailure(response.status, null, response.headers.get('retry-after'));
        throw new GptunnelError('AI_PROVIDER_INVALID_RESPONSE', false);
      }
      if (!response.ok)
        throw providerFailure(response.status, payload, response.headers.get('retry-after'));
      const object = record(payload);
      if (Object.keys(object).length === 0 || (object['error'] && !object['status']))
        throw new GptunnelError('AI_PROVIDER_INVALID_RESPONSE', false);
      if (typeof object['code'] === 'number' && object['code'] !== 0)
        throw providerFailure(400, payload);
      return object;
    } catch (error) {
      if (error instanceof GptunnelError) throw error;
      throw new GptunnelError(
        requestSignal.aborted ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_NETWORK_ERROR',
        true,
      );
    }
  }
}
