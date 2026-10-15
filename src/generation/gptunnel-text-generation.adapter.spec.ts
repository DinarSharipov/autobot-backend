import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateEnvironment } from '../config/environment.js';
import { GptunnelClient } from '../infrastructure/gptunnel/gptunnel.client.js';
import { GptunnelTextGenerationAdapter } from './gptunnel-text-generation.adapter.js';

const input = {
  prompt: 'Пост о космосе',
  topicPromptTemplate: 'Простой стиль',
  idempotencyKey: 'post-1',
};
const reply = (content = 'Готовый пост', finish_reason = 'stop') => ({
  id: 'chat-123',
  choices: [{ message: { content }, finish_reason }],
  usage: { prompt_tokens: 30, completion_tokens: 10 },
});

function adapter(overrides: Record<string, unknown> = {}) {
  const config = new ConfigService<ReturnType<typeof validateEnvironment>, true>(
    validateEnvironment({
      DATABASE_URL: 'postgresql://localhost/autobot_test',
      REDIS_URL: 'redis://localhost:6379',
      GPTUNNEL_API_KEY: 'test-gptunnel-secret',
      ...overrides,
    }),
  );
  return new GptunnelTextGenerationAdapter(config, new GptunnelClient(config));
}

function json(value: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}

describe('GPTunnel text generation', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses the documented authorization and chat schema, sends revision context and returns only final text/accounting', async () => {
    fetchMock.mockResolvedValue(json(reply()));
    const result = await adapter({ GPTUNNEL_USE_WALLET_BALANCE: 'true' }).generate({
      ...input,
      previousText: 'Старый пост',
      revisionFeedback: 'Добавь пример',
      maxCharacters: 1024,
    });
    expect(result).toEqual({
      text: 'Готовый пост',
      providerRequestId: 'chat-123',
      inputUnits: 30,
      outputUnits: 10,
    });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gptunnel.ru/v1/chat/completions');
    expect(options?.headers).toEqual({
      Authorization: 'test-gptunnel-secret',
      'Content-Type': 'application/json',
    });
    if (typeof options?.body !== 'string') throw new Error('Expected JSON body');
    const body = JSON.parse(options.body) as { messages: Array<{ role: string; content: string }> };
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      stream: false,
      useWalletBalance: true,
    });
    expect(body.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[0]?.content).toContain('1024');
    expect(body.messages[1]?.content).toContain('Простой стиль');
    expect(body.messages[2]?.content).toBe('Старый пост');
    expect(body.messages[3]?.content).toContain('Добавь пример');
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('input');
  });

  it.each([
    [401, {}, 'AI_PROVIDER_UNAUTHORIZED', false],
    [402, {}, 'AI_PROVIDER_INSUFFICIENT_BALANCE', false],
    [403, { error: { code: 'model_not_allowed' } }, 'AI_PROVIDER_FORBIDDEN', false],
    [429, { code: 6 }, 'AI_PROVIDER_KEY_LIMIT_EXCEEDED', false],
    [429, { code: 30 }, 'AI_PROVIDER_RATE_LIMITED', true],
    [503, {}, 'AI_PROVIDER_HTTP_503', true],
  ])(
    'classifies HTTP %s without exposing the provider body',
    async (status, payload, code, retryable) => {
      fetchMock.mockResolvedValue(
        json({ ...payload, message: 'private prompt and secret' }, status, { 'Retry-After': '7' }),
      );
      await expect(adapter().generate(input)).rejects.toMatchObject({ code, retryable });
    },
  );

  it('preserves rate-limit delay', async () => {
    fetchMock.mockResolvedValue(json({}, 429, { 'Retry-After': '17' }));
    await expect(adapter().generate(input)).rejects.toMatchObject({ retryAfterSeconds: 17 });
  });

  it.each([
    [reply('', 'stop'), 'AI_PROVIDER_EMPTY_RESPONSE'],
    [reply('Обрезанный текст', 'length'), 'AI_PROVIDER_TRUNCATED_RESPONSE'],
    [reply('', 'content_filter'), 'AI_PROVIDER_CONTENT_REJECTED'],
    [reply('а'.repeat(1025)), 'AI_PROVIDER_TEXT_TOO_LONG'],
    [null, 'AI_PROVIDER_INVALID_RESPONSE'],
  ])('rejects unusable completion %#', async (payload, code) => {
    fetchMock.mockResolvedValue(json(payload));
    await expect(adapter().generate({ ...input, maxCharacters: 1024 })).rejects.toMatchObject({
      code,
      retryable: false,
    });
  });

  it('normalizes network errors and malformed JSON', async () => {
    fetchMock.mockRejectedValueOnce(new Error('sensitive provider URL'));
    await expect(adapter().generate(input)).rejects.toMatchObject({
      message: 'AI_PROVIDER_NETWORK_ERROR',
      retryable: true,
    });
    fetchMock.mockResolvedValueOnce(new Response('not-json'));
    await expect(adapter().generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('fails locally when the key is absent', async () => {
    await expect(adapter({ GPTUNNEL_API_KEY: '' }).generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
