import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBotApiPublicationAdapter } from './telegram-publication.adapter.js';
function adapter() {
  const values: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_API_BASE_URL: 'https://telegram.test',
    TELEGRAM_API_TIMEOUT_MS: 1000,
  };
  return new TelegramBotApiPublicationAdapter({ get: (key: string) => values[key] } as never);
}
afterEach(() => vi.unstubAllGlobals());
describe('Telegram media references', () => {
  it('uploads multipart preview and reads reusable file identifiers from Telegram', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autobot-telegram-media-'));
    const path = join(dir, 'preview.png');
    await writeFile(path, Buffer.from('fixture'));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 1,
            chat: { id: 123 },
            photo: [
              { file_id: 'small', file_unique_id: 'u-small' },
              { file_id: 'largest', file_unique_id: 'u-large' },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await adapter().uploadPhoto(BigInt(123), 'Preview', path)).toEqual({
        chatId: BigInt(123),
        messageId: BigInt(1),
        fileId: 'largest',
        fileUniqueId: 'u-large',
      });
      const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(options.body).toBeInstanceOf(FormData);
      expect((options.body as FormData).get('chat_id')).toBe('123');
      expect((options.body as FormData).get('photo')).toBeInstanceOf(Blob);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('sends file_id as JSON without a file read or regeneration', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 2, chat: { id: -100123 } } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await adapter().sendPhotoByFileId(BigInt(-100123), 'Caption', 'opaque-file-id');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.test/bottest-token/sendPhoto',
      expect.objectContaining({
        body: JSON.stringify({ chat_id: '-100123', caption: 'Caption', photo: 'opaque-file-id' }),
      }),
    );
  });
  it.each([{ photo: [] }, { photo: [{ file_id: '', file_unique_id: 'u' }] }, { photo: [null] }])(
    'rejects an unusable successful upload response %# as ambiguous',
    async ({ photo }) => {
      const dir = await mkdtemp(join(tmpdir(), 'autobot-telegram-media-'));
      const path = join(dir, 'p.png');
      await writeFile(path, Buffer.from('fixture'));
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 123 }, photo } }),
            ),
          ),
      );
      try {
        await expect(adapter().uploadPhoto(BigInt(123), 'Preview', path)).rejects.toMatchObject({
          code: 'MEDIA_UNAVAILABLE',
          ambiguous: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('normalizes expired Telegram file references without a paid fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            description: 'Bad Request: wrong file identifier/HTTP URL specified',
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(
      adapter().sendPhotoByFileId(BigInt(-100123), 'Caption', 'expired'),
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE', retryable: false, ambiguous: false });
  });
});
