import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/autobot',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('validateEnvironment', () => {
  it('validates GPTunnel configuration without falling back to an OpenAI credential', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      OPEN_API_KEY: 'retired-key',
      GPTUNNEL_USE_WALLET_BALANCE: 'true',
      GPTUNNEL_IMAGE_PARAMS: '{"aspect_ratio":"1:1","quality":2}',
    });
    expect(environment.GPTUNNEL_API_KEY).toBeUndefined();
    expect(environment.GPTUNNEL_USE_WALLET_BALANCE).toBe(true);
    expect(environment.GPTUNNEL_IMAGE_PARAMS).toEqual({ aspect_ratio: '1:1', quality: 2 });
    for (const value of ['not-json', '[]', '{"nested":{}}']) {
      expect(() =>
        validateEnvironment({ ...validEnvironment, GPTUNNEL_IMAGE_PARAMS: value }),
      ).toThrow('GPTUNNEL_IMAGE_PARAMS');
    }
  });

  it('applies safe defaults and parses numeric values', () => {
    const environment = validateEnvironment({ ...validEnvironment, PORT: '3100' });

    expect(environment.PORT).toBe(3100);
    expect(environment.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(environment.IMAGE_TEMP_DIR).toBe('.tmp/images');
    expect(environment.PREPAID_GENERATION_ENABLED).toBe(false);
    expect(environment.YOOKASSA_SHOP_ID).toBeUndefined();
  });

  it('rejects wildcard credentialed CORS configuration', () => {
    expect(() => validateEnvironment({ ...validEnvironment, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      'wildcard origins are forbidden',
    );
  });

  it('rejects a non-HTTPS public URL in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'http://api.example.com',
      }),
    ).toThrow('must use HTTPS in production');
  });

  it('does not include secret values in validation errors', () => {
    const secret = 'postgresql://secret-user:secret-password@localhost:5432/autobot';

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: secret.replace('postgresql', 'ftp'),
      }),
    ).toThrowError(/DATABASE_URL/);

    try {
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: secret.replace('postgresql', 'ftp'),
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });

  it('requires complete OIDC and rotated bot key pairs', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        TELEGRAM_OIDC_CLIENT_ID: '123',
      }),
    ).toThrow('must be configured together');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        BOT_SERVICE_PREVIOUS_KEY_ID: 'previous',
      }),
    ).toThrow('must be configured together');
  });

  it('allows production bot-only mode without browser OIDC', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.example.com',
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        BOT_SERVICE_ACTIVE_KEY_ID: 'bot-v1',
        BOT_SERVICE_ACTIVE_SECRET: 'a'.repeat(32),
        YOOKASSA_SHOP_ID: 'shop-id',
        YOOKASSA_SECRET_KEY: 'secret-key',
      }),
    ).not.toThrow();
  });

  it('requires YooKassa credentials in production without exposing their values', () => {
    const productionEnvironment = {
      ...validEnvironment,
      NODE_ENV: 'production',
      API_PUBLIC_URL: 'https://api.example.com',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      BOT_SERVICE_ACTIVE_KEY_ID: 'bot-v1',
      BOT_SERVICE_ACTIVE_SECRET: 'a'.repeat(32),
    };

    expect(() => validateEnvironment(productionEnvironment)).toThrow('YOOKASSA_SHOP_ID');

    const secret = 'yookassa-secret-value';
    try {
      validateEnvironment({
        ...productionEnvironment,
        YOOKASSA_SECRET_KEY: secret,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('requires secure cookies for SameSite=None', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_COOKIE_SAME_SITE: 'none',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('must be true when SameSite=None');
  });

  it('requires a separate token when metrics are enabled', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        METRICS_ENABLED: 'true',
      }),
    ).toThrow('METRICS_AUTH_TOKEN');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        METRICS_ENABLED: 'true',
        METRICS_AUTH_TOKEN: 'm'.repeat(32),
      }),
    ).not.toThrow();
  });
  it('keeps checkout and webhook disabled and requires explicit test users on enable', () => {
    const environment = validateEnvironment(validEnvironment);
    expect(environment.YOOKASSA_TEST_CHECKOUT_ENABLED).toBe(false);
    expect(environment.YOOKASSA_WEBHOOK_ENABLED).toBe(false);
    expect(() =>
      validateEnvironment({ ...validEnvironment, YOOKASSA_TEST_CHECKOUT_ENABLED: 'true' }),
    ).toThrow('YOOKASSA_TEST_USER_IDS');
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        YOOKASSA_TEST_CHECKOUT_ENABLED: 'true',
        YOOKASSA_SHOP_ID: 'shop',
        YOOKASSA_SECRET_KEY: 'test-key',
        YOOKASSA_RETURN_URL: 'https://example.test/return',
        YOOKASSA_TEST_USER_IDS: '11111111-1111-4111-8111-111111111111',
      }),
    ).not.toThrow();
  });
});
