import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const base = {
  DATABASE_URL: 'postgresql://localhost/autobot_test',
  REDIS_URL: 'redis://localhost:6379',
};
function check(overrides: Record<string, unknown> = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'test/acceptance/validate-environment-child.mjs'],
      { input: JSON.stringify({ ...base, ...overrides }), encoding: 'utf8', timeout: 10000 },
    ),
  ) as { ok: boolean; message?: string };
}
describe('Isolated configuration validation processes', () => {
  it('TC-ENV-002 missing DATABASE_URL rejected naming field only', () => {
    const r = check({ DATABASE_URL: undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('DATABASE_URL');
  });
  it('TC-ENV-003 ftp database protocol rejected', () =>
    expect(check({ DATABASE_URL: 'ftp://localhost/autobot_test' }).ok).toBe(false));
  it.each([undefined, 'http://localhost:6379'])(
    'TC-ENV-004 invalid Redis URL %s rejected',
    (REDIS_URL) => expect(check({ REDIS_URL }).ok).toBe(false),
  );
  it.each([1, 65535, 0, 65536, 1.5, 'invalid'])('TC-ENV-005 PORT %s boundary', (PORT) =>
    expect(check({ PORT }).ok).toBe(PORT === 1 || PORT === 65535),
  );
  const prod = {
    NODE_ENV: 'production',
    API_PUBLIC_URL: 'https://api.example.test',
    BOT_SERVICE_ACTIVE_KEY_ID: 'active',
    BOT_SERVICE_ACTIVE_SECRET: 'a'.repeat(32),
    TELEGRAM_BOT_TOKEN: 'fixture-token',
  };
  it('TC-ENV-006 HTTP API_PUBLIC_URL rejected in production', () =>
    expect(check({ ...prod, API_PUBLIC_URL: 'http://api.example.test' }).ok).toBe(false));
  for (const prefix of ['ACTIVE', 'PREVIOUS'])
    it.each(['id', 'secret'])('TC-ENV-007 ' + prefix + ' incomplete %s pair rejected', (part) =>
      expect(
        check({
          [`BOT_SERVICE_${prefix}_KEY_ID`]: part === 'id' ? 'fixture' : undefined,
          [`BOT_SERVICE_${prefix}_SECRET`]: part === 'secret' ? 's'.repeat(32) : undefined,
        }).ok,
      ).toBe(false),
    );
  it.each([31, 32])('TC-ENV-008 HMAC secret length %s', (length) =>
    expect(
      check({ BOT_SERVICE_ACTIVE_KEY_ID: 'active', BOT_SERVICE_ACTIVE_SECRET: 's'.repeat(length) })
        .ok,
    ).toBe(length === 32),
  );
  it('TC-ENV-009 identical rotation key IDs rejected', () =>
    expect(
      check({
        BOT_SERVICE_ACTIVE_KEY_ID: 'same',
        BOT_SERVICE_PREVIOUS_KEY_ID: 'same',
        BOT_SERVICE_ACTIVE_SECRET: 'a'.repeat(32),
        BOT_SERVICE_PREVIOUS_SECRET: 'b'.repeat(32),
      }).ok,
    ).toBe(false));
  it('configuration-partial bot-only production configuration accepted', () =>
    expect(check(prod).ok).toBe(true));
  it.each([1, 2, 3, 4, 5, 6])('TC-ENV-011 incomplete OIDC combination %s rejected', (mask) =>
    expect(
      check({
        TELEGRAM_OIDC_CLIENT_ID: mask & 1 ? 'id' : undefined,
        TELEGRAM_OIDC_CLIENT_SECRET: mask & 2 ? 's'.repeat(16) : undefined,
        TELEGRAM_OIDC_REDIRECT_URI: mask & 4 ? 'https://api.example.test/callback' : undefined,
        WEB_ALLOWED_RETURN_URLS: 'https://web.example.test/app',
      }).ok,
    ).toBe(false),
  );
  it.each([
    '{}',
    '{"size":1024,"hd":true,"style":"test"}',
    '{"a":null}',
    '{"a":{}}',
    '[]',
    'false',
    'broken',
  ])('TC-ENV-014 image params %s have bounded flat primitive schema', (GPTUNNEL_IMAGE_PARAMS) =>
    expect(check({ GPTUNNEL_IMAGE_PARAMS }).ok).toBe(
      GPTUNNEL_IMAGE_PARAMS === '{}' || GPTUNNEL_IMAGE_PARAMS.includes('"size"'),
    ),
  );
  const fields = [
    ['AI_TEXT_MAX_TOKENS', 128, 32768],
    ['AI_REQUEST_TIMEOUT_MS', 1000, 120000],
    ['AI_IMAGE_TIMEOUT_MS', 1000, 600000],
    ['AI_IMAGE_POLL_INTERVAL_MS', 100, 10000],
    ['TELEGRAM_API_TIMEOUT_MS', 1000, 60000],
    ['OIDC_FLOW_TTL_SECONDS', 60, 1800],
    ['OIDC_REQUEST_TIMEOUT_MS', 1000, 60000],
    ['BOT_SERVICE_CLOCK_SKEW_SECONDS', 1, 300],
    ['BOT_SERVICE_NONCE_TTL_SECONDS', 60, 900],
    ['AUTH_RATE_LIMIT_MAX', 1, 1000],
    ['AUTH_RATE_LIMIT_WINDOW_SECONDS', 1, 3600],
    ['PUBLICATION_MAX_ATTEMPTS', 1, 20],
  ] as const;
  for (const [field, min, max] of fields)
    it.each([min - 1, min, max, max + 1, 0, -1])(
      'TC-ENV-015 ' + field + '=%s boundaries',
      (value) => expect(check({ [field]: value }).ok).toBe(value >= min && value <= max),
    );
  it('TC-ENV-016 configuration error output never includes secret marker', () => {
    const marker = 'DO_NOT_EXPOSE_7bdda919';
    const r = check({
      DATABASE_URL: 'ftp://' + marker + '@localhost/test',
      GPTUNNEL_API_KEY: marker,
      BOT_SERVICE_ACTIVE_SECRET: marker,
      TELEGRAM_OIDC_CLIENT_SECRET: marker,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(marker);
  });
});
