import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnvironment } from '../../src/config/environment.js';
import { GptunnelClient } from '../../src/infrastructure/gptunnel/gptunnel.client.js';
import { ImageTempService } from '../../src/infrastructure/image-temp/image-temp.service.js';
import { GptunnelImageGenerationAdapter } from '../../src/publishing/gptunnel-image-generation.adapter.js';
import { TelegramBotApiPublicationAdapter } from '../../src/publishing/telegram-publication.adapter.js';
const taskId = '6a61e021a6e77553a989c41d';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const models = { code: 0, models: [{ id: 'gpt-image', type: 'IMAGE', inputs: [] }] };
const task = (overrides: Record<string, unknown> = {}) => ({
  code: 0,
  id: taskId,
  status: 'done',
  result: [{ url: 'https://storage.example.test/image.png' }],
  ...overrides,
});
const input = {
  prompt: 'fixture description',
  text: 'fixture final text',
  idempotencyKey: 'publication-fixture-image',
};
describe('Media and Telegram adapters against controlled HTTP', () => {
  let directory: string,
    config: ConfigService<ReturnType<typeof validateEnvironment>, true>,
    temp: ImageTempService,
    image: GptunnelImageGenerationAdapter,
    telegram: TelegramBotApiPublicationAdapter;
  const upstream = vi.fn<typeof fetch>();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'autobot-media-acceptance-'));
    config = new ConfigService(
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/autobot_test',
        REDIS_URL: 'redis://localhost',
        GPTUNNEL_API_KEY: 'fixture-provider-key',
        TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        IMAGE_TEMP_DIR: directory,
        IMAGE_MAX_BYTES: 64,
        AI_IMAGE_TIMEOUT_MS: 1000,
        AI_REQUEST_TIMEOUT_MS: 1000,
        AI_IMAGE_POLL_INTERVAL_MS: 100,
      }),
    );
    temp = new ImageTempService(config);
    await temp.onModuleInit();
    image = new GptunnelImageGenerationAdapter(config, temp, new GptunnelClient(config));
    telegram = new TelegramBotApiPublicationAdapter(config);
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(async () => {
    temp.onModuleDestroy();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  function successfulTask(result = task()) {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(result))
      .mockResolvedValueOnce(new Response(png));
  }
  it('TC-IMG-003 task uses explicit GPTunnel protocol and stable idempotency key', async () => {
    successfulTask();
    await image.generate(input);
    const [url, options] = upstream.mock.calls[1]!;
    expect(url).toBe('https://gptunnel.ru/api/v2/media/tasks');
    expect(options?.headers).toMatchObject({ Authorization: 'fixture-provider-key' });
    const body = JSON.parse(options?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-image',
      params: {},
      idempotency_key: input.idempotencyKey,
      wait: false,
    });
    expect(body.prompt).toEqual(expect.stringContaining(input.text));
    for (const key of ['size', 'response_format', 'n', 'quality'])
      expect(body).not.toHaveProperty(key);
  });
  it('TC-IMG-004 required input rejected before paid task', async () => {
    upstream.mockResolvedValueOnce(
      json({ code: 0, models: [{ id: 'gpt-image', type: 'IMAGE', inputs: [{ required: true }] }] }),
    );
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_MODEL_REQUIRES_INPUT',
      retryable: false,
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each(['VIDEO', 'AUDIO', 'missing'])(
    'TC-IMG-005 unsuitable model type %s rejected',
    async (type) => {
      upstream.mockResolvedValueOnce(
        json({ code: 0, models: type === 'missing' ? [] : [{ id: 'gpt-image', type }] }),
      );
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_MODEL_UNAVAILABLE',
      });
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );
  it('TC-IMG-006 default params leave model defaults to provider', async () => {
    successfulTask();
    await image.generate(input);
    expect(JSON.parse(upstream.mock.calls[1]![1]!.body as string)).toMatchObject({ params: {} });
  });
  it('media-partial configured params forwarded unchanged', async () => {
    config.set('GPTUNNEL_IMAGE_PARAMS', { aspect_ratio: '1:1', resolution: 1024 });
    successfulTask();
    await image.generate(input);
    expect(JSON.parse(upstream.mock.calls[1]![1]!.body as string)).toMatchObject({
      params: { aspect_ratio: '1:1', resolution: 1024 },
    });
  });
  it('TC-IMG-008 invalid upstream params terminate without replacement task', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json({ message: 'PRIVATE' }, 400));
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_HTTP_400',
      retryable: false,
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('TC-IMG-009 queued running done downloads only after done', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task({ status: 'queued' })))
      .mockResolvedValueOnce(json(task({ status: 'running' })))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(new Response(png));
    const r = await image.generate(input);
    expect(await readFile(r.filePath)).toEqual(png);
    expect(
      upstream.mock.calls.map((x) =>
        typeof x[0] === 'string' ? x[0] : x[0] instanceof URL ? x[0].href : x[0].url,
      ),
    ).toEqual([
      'https://gptunnel.ru/api/v2/media/models?type=IMAGE',
      'https://gptunnel.ru/api/v2/media/tasks',
      `https://gptunnel.ru/api/v2/media/tasks/${taskId}`,
      `https://gptunnel.ru/api/v2/media/tasks/${taskId}`,
      'https://storage.example.test/image.png',
    ]);
  });
  it('TC-IMG-010 immediate done avoids polling and downloads without credentials', async () => {
    successfulTask();
    await image.generate(input);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(upstream.mock.calls[2]![1]).not.toHaveProperty('headers');
  });
  it('TC-IMG-011 lost create response retries exact same key and request', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockRejectedValueOnce(new Error('lost create response'));
    await expect(image.generate(input)).rejects.toMatchObject({ retryable: true });
    successfulTask();
    await image.generate(input);
    expect(upstream.mock.calls[1]![1]?.body).toBe(upstream.mock.calls[3]![1]?.body);
  });
  it('TC-IMG-012 download retry reuses provider task key without replacement', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockRejectedValueOnce(new Error('download failed'));
    await expect(image.generate(input)).rejects.toMatchObject({ code: 'AI_IMAGE_DOWNLOAD_FAILED' });
    successfulTask();
    await image.generate(input);
    expect(upstream.mock.calls[1]![1]?.body).toBe(upstream.mock.calls[4]![1]?.body);
  });
  it('TC-IMG-013 provider idempotency conflict never changes key silently', async () => {
    upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json({ code: 23 }, 409));
    await expect(image.generate(input)).rejects.toMatchObject({ retryable: false });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(JSON.parse(upstream.mock.calls[1]![1]!.body as string)).toHaveProperty(
      'idempotency_key',
      input.idempotencyKey,
    );
  });
  it('TC-IMG-014 key limit is terminal', async () => {
    upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json({ code: 6 }, 429));
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_KEY_LIMIT_EXCEEDED',
      retryable: false,
    });
  });
  it('TC-IMG-017 insufficient balance terminates generation', async () => {
    upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json({ code: 5 }, 402));
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_INSUFFICIENT_BALANCE',
      retryable: false,
    });
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([25, 26, 27, 28, 1001, 1002])(
    'TC-IMG-018 failed task code %s has no paid replacement',
    async (code) => {
      upstream
        .mockResolvedValueOnce(json(models))
        .mockResolvedValueOnce(
          json(task({ status: 'failed', error: { code, title: 'PRIVATE_PROVIDER_TITLE' } })),
        );
      await expect(image.generate(input)).rejects.toMatchObject({
        code: `AI_IMAGE_TASK_FAILED_${code}`,
        retryable: false,
      });
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it('TC-IMG-019 unknown provider task errors discard raw titles', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(
        json(task({ status: 'failed', error: { code: 99999, title: 'PRIVATE_PROVIDER_TITLE' } })),
      );
    await expect(image.generate(input)).rejects.toMatchObject({
      message: 'AI_IMAGE_TASK_FAILED_99999',
      retryable: false,
    });
  });
  it.each([undefined, 123, 'short', '../unsafe-path', 'a'.repeat(25)])(
    'TC-IMG-020 invalid task ID variant %# never polls unsafe URL',
    async (id) => {
      upstream
        .mockResolvedValueOnce(json(models))
        .mockResolvedValueOnce(json(task({ id, status: 'queued' })));
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_INVALID_RESPONSE',
      });
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );
  it('TC-IMG-021 changed task ID in poll rejected', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task({ status: 'queued' })))
      .mockResolvedValueOnce(json(task({ id: 'a'.repeat(24) })));
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_INVALID_RESPONSE',
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it.each([undefined, 'mysterious'])(
    'TC-IMG-022 unknown task status %# rejected without infinite polling',
    async (status) => {
      upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json(task({ status })));
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_INVALID_RESPONSE',
      });
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );
  it('TC-IMG-023 never-ending running task stops at overall timeout', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockImplementation(() => Promise.resolve(json(task({ status: 'running' }))));
    const start = performance.now();
    await expect(image.generate(input)).rejects.toMatchObject({
      retryable: true,
    });
    expect(performance.now() - start).toBeLessThan(2500);
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([undefined, [], [{}]])('TC-IMG-024 empty done result %# rejected', async (result) => {
    upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json(task({ result })));
    await expect(image.generate(input)).rejects.toMatchObject({ code: 'AI_IMAGE_EMPTY_RESPONSE' });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it.each([
    'http://storage.example.test/x',
    'file:///tmp/x',
    'data:image/png;base64,abc',
    'https://user:pass@storage.example.test/x',
  ])('TC-IMG-025 unsafe result URL variant %# rejected before download', async (url) => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task({ result: [{ url }] })));
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_INVALID_RESPONSE',
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it.each([301, 302, 307])(
    'TC-IMG-026 storage redirect HTTP %s is not followed',
    async (status) => {
      upstream
        .mockResolvedValueOnce(json(models))
        .mockResolvedValueOnce(json(task()))
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { location: 'https://other.example.test/' } }),
        );
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_DOWNLOAD_FAILED',
      });
      expect(upstream.mock.calls[2]![1]).toMatchObject({ redirect: 'error' });
      expect(upstream).toHaveBeenCalledTimes(3);
    },
  );
  it.each([403, 404, 429, 500, 'timeout'])(
    'TC-IMG-027 storage %s classification does not expose URL',
    async (status) => {
      upstream.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json(task()));
      if (status === 'timeout') upstream.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_URL'));
      else upstream.mockResolvedValueOnce(new Response(null, { status: Number(status) }));
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_DOWNLOAD_FAILED',
        retryable: status === 'timeout' || status === 429 || status === 500,
        message: 'AI_IMAGE_DOWNLOAD_FAILED',
      });
    },
  );
  it.each(['declared', 'chunked'])(
    'TC-IMG-028 oversized %s download stops before disk write',
    async (mode) => {
      upstream
        .mockResolvedValueOnce(json(models))
        .mockResolvedValueOnce(json(task()))
        .mockResolvedValueOnce(
          new Response(new Uint8Array(65), {
            headers: mode === 'declared' ? { 'Content-Length': '65' } : {},
          }),
        );
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
      });
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it('TC-IMG-029 misleading small Content-Length does not bypass actual size bound', async () => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(65), { headers: { 'Content-Length': '1' } }),
      );
    await expect(image.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
    });
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['<html>fake image</html>', '{"url":"fake"}'])(
    'TC-IMG-030 non-image variant %# rejected despite image MIME',
    async (data) => {
      upstream
        .mockResolvedValueOnce(json(models))
        .mockResolvedValueOnce(json(task()))
        .mockResolvedValueOnce(new Response(data, { headers: { 'Content-Type': 'image/png' } }));
      await expect(image.generate(input)).rejects.toMatchObject({
        code: 'AI_IMAGE_INVALID_FORMAT',
      });
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each([4096, 4097])(
    'TC-PUB-005 Telegram text length %s checked before network',
    async (length) => {
      upstream.mockResolvedValue(
        json({ ok: true, result: { message_id: 1, chat: { id: -100111 } } }),
      );
      if (length === 4096)
        expect(await telegram.sendText(-100111n, 'x'.repeat(length))).toMatchObject({
          messageId: 1n,
        });
      else {
        await expect(telegram.sendText(-100111n, 'x'.repeat(length))).rejects.toMatchObject({
          code: 'PUBLICATION_TEXT_TOO_LONG',
        });
        expect(upstream).not.toHaveBeenCalled();
      }
    },
  );
  it.each([1024, 1025])(
    'TC-PUB-006 photo caption length %s checked before upload',
    async (length) => {
      const path = join(directory, 'fixture.png');
      await writeFile(path, png);
      upstream.mockResolvedValue(
        json({ ok: true, result: { message_id: 1, chat: { id: -100111 } } }),
      );
      if (length === 1024) await telegram.sendPhoto(-100111n, 'x'.repeat(length), path);
      else {
        await expect(telegram.sendPhoto(-100111n, 'x'.repeat(length), path)).rejects.toMatchObject({
          code: 'PUBLICATION_CAPTION_TOO_LONG',
        });
        expect(upstream).not.toHaveBeenCalled();
      }
    },
  );
  it('TC-PUB-007 special characters sent intact without parse_mode', async () => {
    upstream.mockResolvedValue(
      json({ ok: true, result: { message_id: 1, chat: { id: -100111 } } }),
    );
    const text = '<>& *Markdown* https://example.test 😀';
    await telegram.sendText(-100111n, text);
    const body = JSON.parse(upstream.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.text).toBe(text);
    expect(body).not.toHaveProperty('parse_mode');
  });
  it.each(['text', 'photo'])('TC-PUB-008 missing bot token for %s fails locally', async (kind) => {
    config.set('TELEGRAM_BOT_TOKEN', '');
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '';
    try {
      await expect(
        kind === 'text'
          ? telegram.sendText(-100111n, 'final')
          : telegram.sendPhoto(-100111n, 'final', 'not-opened'),
      ).rejects.toMatchObject({ code: 'TELEGRAM_NOT_CONFIGURED' });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });
  it('TC-PUB-014 malformed Telegram JSON is ambiguous rather than retryable', async () => {
    upstream.mockResolvedValue(new Response('not json'));
    await expect(telegram.sendText(-100111n, 'final')).rejects.toMatchObject({
      ambiguous: true,
      retryable: false,
    });
  });
  it.each([{}, { message_id: 1 }, { chat: { id: -100111 } }])(
    'TC-PUB-015 missing message or chat identifier variant %# is ambiguous',
    async (result) => {
      upstream.mockResolvedValue(json({ ok: true, result }));
      await expect(telegram.sendText(-100111n, 'final')).rejects.toMatchObject({
        code: 'TELEGRAM_INVALID_RESPONSE',
        ambiguous: true,
      });
    },
  );
  it('TC-PUB-016 mismatching returned chat ID must never be trusted as requested target', async () => {
    upstream.mockResolvedValue(
      json({ ok: true, result: { message_id: 1, chat: { id: -100222 } } }),
    );
    await expect(telegram.sendText(-100111n, 'final')).rejects.toMatchObject({ ambiguous: true });
  });
  it.each([
    'https://localhost/image',
    'https://127.0.0.1/image',
    'https://10.0.0.1/image',
    'https://192.168.1.1/image',
    'https://[::1]/image',
    'https://169.254.169.254/latest/meta-data/',
  ])('TC-SEC-006 private result URL variant %# never reaches fetch', async (url) => {
    upstream
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task({ result: [{ url }] })))
      .mockResolvedValueOnce(new Response(png));
    await expect(image.generate(input)).rejects.toMatchObject({ retryable: false });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
