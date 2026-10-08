import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalBotRequest, canonicalPathAndQuery } from './bot-request-signature.service.js';

describe('bot request canonicalization', () => {
  it('matches the accepted cross-repository signature vector', () => {
    const canonical = canonicalBotRequest({
      method: 'POST',
      originalUrl: '/api/v1/internal/telegram-users/resolve',
      body: Buffer.from('{"firstName":"Dinar","username":"dinar"}'),
      timestamp: '1791446400',
      nonce: '123e4567-e89b-42d3-a456-426614174000',
      telegramUserId: '123456789',
    });
    const signature = createHmac('sha256', 'test-secret-32-bytes-long-1234567890')
      .update(canonical)
      .digest('hex');

    expect(signature).toBe('d634028aa8874b6fb90ae13f8eb02b92705ced5cd3ec802ef59ca5154aef0196');
    expect(canonical.split('\n')).toHaveLength(6);
    expect(canonical.endsWith('\n')).toBe(false);
  });

  it('sorts encoded query keys and values deterministically', () => {
    expect(canonicalPathAndQuery('/path?z=last&a=two&a=one&space=hello+world')).toBe(
      '/path?a=one&a=two&space=hello%20world&z=last',
    );
  });
});
