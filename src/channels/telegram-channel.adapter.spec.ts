import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import { TelegramBotApiChannelAdapter } from './telegram-channel.adapter.js';

function adapter(): TelegramBotApiChannelAdapter {
  const values: Partial<AppEnvironment> = {
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_API_BASE_URL: 'https://telegram.example.test',
    TELEGRAM_API_TIMEOUT_MS: 1000,
  };
  const config = {
    get: (key: keyof AppEnvironment) => values[key],
  } as ConfigService<AppEnvironment, true>;
  return new TelegramBotApiChannelAdapter(config);
}

function telegramResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TelegramBotApiChannelAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns Telegram metadata when the bot can post', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        telegramResponse({ type: 'channel', title: 'Autobot', username: 'autobot_channel' }),
      )
      .mockResolvedValueOnce(telegramResponse({ id: 123 }))
      .mockResolvedValueOnce(
        telegramResponse({ status: 'administrator', can_post_messages: true }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter().validate(-100123n)).resolves.toMatchObject({
      telegramChatId: -100123n,
      title: 'Autobot',
      username: 'autobot_channel',
    });
  });

  it('rejects a bot without posting permissions', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(telegramResponse({ type: 'channel', title: 'Autobot' }))
        .mockResolvedValueOnce(telegramResponse({ id: 123 }))
        .mockResolvedValueOnce(
          telegramResponse({ status: 'administrator', can_post_messages: false }),
        ),
    );

    await expect(adapter().validate(-100123n)).rejects.toMatchObject({
      response: { code: 'TELEGRAM_BOT_CANNOT_POST' },
    });
  });

  it('maps Telegram timeouts and upstream failures to dependency unavailability', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout')));
    await expect(adapter().validate(-100123n)).rejects.toMatchObject({
      response: { code: 'TELEGRAM_API_UNAVAILABLE' },
    });

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(telegramResponse({}, 500)));
    await expect(adapter().validate(-100123n)).rejects.toMatchObject({
      response: { code: 'TELEGRAM_API_UNAVAILABLE' },
    });
  });
});
