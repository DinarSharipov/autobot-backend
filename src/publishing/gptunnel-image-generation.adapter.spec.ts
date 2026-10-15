import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateEnvironment } from '../config/environment.js';
import { GptunnelClient } from '../infrastructure/gptunnel/gptunnel.client.js';
import { ImageTempService } from '../infrastructure/image-temp/image-temp.service.js';
import { GptunnelImageGenerationAdapter } from './gptunnel-image-generation.adapter.js';

const id = '6a61e021a6e77553a989c41d';
const input = { prompt: 'Космос', text: 'Готовый пост', idempotencyKey: 'publication:1:image' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const models = { code: 0, models: [{ id: 'gpt-image', type: 'IMAGE', params: [], inputs: [] }] };
const task = (status = 'done') => ({
  code: 0,
  id,
  status,
  result: [{ url: 'https://storage.example.test/image.png' }],
});
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });

describe('GPTunnel Creative Lab image generation', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let directory: string;
  let temporaryImages: ImageTempService;
  let config: ConfigService<ReturnType<typeof validateEnvironment>, true>;
  let adapter: GptunnelImageGenerationAdapter;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    directory = await mkdtemp(join(tmpdir(), 'autobot-gptunnel-'));
    config = new ConfigService(
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/autobot_test',
        REDIS_URL: 'redis://localhost:6379',
        GPTUNNEL_API_KEY: 'test-gptunnel-secret',
        IMAGE_TEMP_DIR: directory,
        AI_IMAGE_POLL_INTERVAL_MS: 100,
        GPTUNNEL_IMAGE_PARAMS: '{"aspect_ratio":"1:1"}',
      }),
    );
    temporaryImages = new ImageTempService(config);
    await temporaryImages.onModuleInit();
    adapter = new GptunnelImageGenerationAdapter(
      config,
      temporaryImages,
      new GptunnelClient(config),
    );
  });
  afterEach(async () => {
    temporaryImages.onModuleDestroy();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('creates an idempotent task, polls to done and downloads into restricted ephemeral storage without forwarding credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task('queued')))
      .mockResolvedValueOnce(json(task('running')))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(new Response(png));
    const result = await adapter.generate(input);
    expect(await readFile(result.filePath)).toEqual(png);
    expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const create = fetchMock.mock.calls[1]!;
    expect(create[0]).toBe('https://gptunnel.ru/api/v2/media/tasks');
    if (typeof create[1]?.body !== 'string') throw new Error('Expected JSON body');
    expect(JSON.parse(create[1].body) as unknown).toMatchObject({
      model: 'gpt-image',
      params: { aspect_ratio: '1:1' },
      idempotency_key: input.idempotencyKey,
      wait: false,
    });
    expect(fetchMock.mock.calls[2]![0]).toBe(`https://gptunnel.ru/api/v2/media/tasks/${id}`);
    const download = fetchMock.mock.calls[4]!;
    expect((download[0] as URL).href).toBe('https://storage.example.test/image.png');
    expect(download[1]).not.toHaveProperty('headers');
    expect(download[1]?.redirect).toBe('error');
    expect(result.filePath).toMatch(/\.png$/);
    expect(Object.keys(result)).toEqual(['filePath']);
    await temporaryImages.remove(result.filePath);
    expect(await readdir(directory)).toEqual([]);
  });

  it('reuses the same provider idempotency key on a download retry', async () => {
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockRejectedValueOnce(new Error('private storage URL'))
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(new Response(png));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_DOWNLOAD_FAILED',
      retryable: true,
    });
    await adapter.generate(input);
    const bodies = fetchMock.mock.calls
      .filter(([url]) => url === 'https://gptunnel.ru/api/v2/media/tasks')
      .map(([, options]) => options?.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it.each([25, 26, 27, 28, 1001, 1002])(
    'stops failed task %s without persisting provider content or creating a paid replacement',
    async (code) => {
      fetchMock.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(
        json({
          ...task('failed'),
          error: { code, title: 'SECRET_PROMPT', message: 'SECRET_PROMPT' },
        }),
      );
      await expect(adapter.generate(input)).rejects.toMatchObject({
        code: `AI_IMAGE_TASK_FAILED_${code}`,
        retryable: false,
        message: `AI_IMAGE_TASK_FAILED_${code}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('bounds polling and reports a retryable timeout', async () => {
    config.set('AI_IMAGE_TIMEOUT_MS', 20);
    fetchMock.mockResolvedValueOnce(json(models)).mockResolvedValueOnce(json(task('running')));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_PROVIDER_TIMEOUT',
      retryable: true,
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    [{ code: 0, models: [] }, 'AI_IMAGE_MODEL_UNAVAILABLE'],
    [
      { code: 0, models: [{ id: 'gpt-image', type: 'IMAGE', inputs: [{ required: true }] }] },
      'AI_IMAGE_MODEL_REQUIRES_INPUT',
    ],
  ])('rejects unusable image models %# before creating a task', async (catalogue, code) => {
    fetchMock.mockResolvedValueOnce(json(catalogue));
    await expect(adapter.generate(input)).rejects.toMatchObject({ code, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After on media rate limits', async () => {
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json({ code: 30 }, 429, { 'Retry-After': '19' }));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 19,
    });
  });

  it.each([
    'http://storage.example.test/image.png',
    'https://secret@storage.example.test/image.png',
    'file:///tmp/image.png',
  ])('rejects unsafe result URL %s', async (url) => {
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json({ ...task(), result: [{ url }] }));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized images while streaming even without Content-Length', async () => {
    config.set('IMAGE_MAX_BYTES', 8);
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 8));
              controller.enqueue(png.subarray(8));
              controller.close();
            },
          }),
        ),
      );
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
      retryable: false,
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects non-image downloads', async () => {
    fetchMock
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(task()))
      .mockResolvedValueOnce(new Response('<html>provider error</html>'));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      code: 'AI_IMAGE_INVALID_FORMAT',
      retryable: false,
    });
    expect(await readdir(directory)).toEqual([]);
  });
});
